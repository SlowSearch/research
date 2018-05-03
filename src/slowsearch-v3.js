import {memoizingStemmer as stemmer} from 'porter-stemmer';
import {english} from 'stopwords';
import {open as idbOpen} from 'idb';

const stopwords = new Set(english);
const dbName = 'search-v3';
const dbStoreDocs = 'docs';
const dbStoreIndex = 'index';
const dbStoreTerms = 'terms';
const dbRO = 'readonly';
const dbRW = 'readwrite';

//TODO: recover from weird DB states, probably best to first make a delete/clear all method

// is storing one tie for terms with word count & index faster / more space efficient?

let _db;
async function db() {
  if (_db) {
    return _db;
  }
  _db = await idbOpen(dbName, 1, upgradedb => {
    upgradedb.createObjectStore(dbStoreIndex);
    upgradedb.createObjectStore(dbStoreDocs, {autoIncrement: true});
    upgradedb.createObjectStore(dbStoreTerms);
  });
  return _db;
}

export function close() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

async function addDocRef(transaction, doc) {
  const docId = await transaction.objectStore(dbStoreDocs).add(doc.text.substring(0, 64), doc.id);
  return docId;
}

const termCache = (() => {
  let cache = new Map();
  let cacheEqualsObjectStore = false;
  const inserts = new Set();
  const queue = new Map();

  async function getIdAndIncreaseDf(transaction, term) {
    const termObj = queue.get(term) || await get(transaction, term) || {id: inserts.size + await getTermCount(transaction), count: 0};
    if (termObj.count === 0) {
      inserts.add(term);
    }
    termObj.count++;
    queue.set(term, termObj);
    return termObj.id;
  }

  function discardUpdates() {
    inserts.clear();
    queue.clear();
  }

  async function storeUpdatesToDB(transaction) {
    const newCache = new Map(cache);
    const store = transaction.objectStore(dbStoreTerms);
    const requests = [];
    for(const [term, value] of queue) {
      requests.push(inserts.has(term) ? store.add(value, term) : store.put(value, term));
      newCache.set(term, value);
    }
    await Promise.all(requests);
    cache = newCache;
    inserts.clear();
    queue.clear();
  }

  async function get(transaction, term) {
    const value = cache.get(term);
    if (value || cacheEqualsObjectStore) {
      return value;
    }
    const dbValue = await transaction.objectStore(dbStoreTerms).get(term);
    cache.set(term, dbValue);
    return dbValue;
  }

  function prefill(transaction) {
    // Since idb does not yet support await cursor, we have to use a promise here
    return new Promise(resolve => {
      if (cacheEqualsObjectStore) {
        return resolve();
      }
      transaction.objectStore(dbStoreTerms).iterateCursor(cursor => {
        if (!cursor) {
          cacheEqualsObjectStore = true;
          return resolve();
        }
        cache.set(cursor.key, cursor.value);
        cursor.continue();
      })
    });
  }

  return {
    get,
    getIdAndIncreaseDf,
    discardUpdates,
    storeUpdatesToDB,
    prefill
  };
})();

//const getScaledTf = (termCount, docSize) => Math.floor(Math.sqrt(termCount / docSize) * 255);
//const bm25k1 = 1.2, bm25b = 0.75, bm25avg = 2000;
//const bm25 = (termCount,docSize,avg) => Math.floor(255 * ((termCount / docSize) * (bm25k1 + 1)) / (termCount / docSize + bm25k1 *(1 - bm25b + bm25b * (docSize / bm25avg))));

const bm15k1 = 1.2;//, bm15b = 0.75;
const getScaledBm15 = (termCount, docSize) => Math.floor(255 * ((termCount / docSize) * (bm15k1 + 1)) / (termCount / docSize + bm15k1));

//NOTE:
// We are using a Number (float64) for key storage, because this is the most efficient way in FireFox
// to store key data in indexedDB: https://github.com/mozilla/gecko/blob/central/dom/indexedDB/Key.cpp#L34-L109
// since other binary data is less efficient:
// - Strings: if a char > 7E, it will need more than 8 bits to be stored (and they need 2 to prefix the long byte alternative with '10' for correct sorting)
// - Blob: if a byte > 7E, it will costs 16 instead of 8 bits, data wise this means we can only use 7 bits per 8 storage bits
//
// This is our data diagram of the key:
//  0                   1                   2                   3
//  0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
// +-----------------------------------------------+---------------+
// |                  Term ID (24)                 |   Score (8)   |
// +-----------------------------------------------+---------------+
// |                        Document ID (32)                       |
// +---------------------------------------------------------------+
//
//  Variable    | Byte Offset | Byte Size | Bit Range
// -------------+-------------+-----------+-----------
//  Term ID     |           0 |         3 |    00..23
//  Score       |           3 |         1 |    23..31
//  Document ID |           4 |         4 |    31..63
// 
// To quote Mozilla:
// > When encoding floats, 64bit IEEE 754 are almost sortable, except that
// > positive sort lower than negative, and negative sort descending. So we use
// > the following encoding:
// > value < 0 ?
// >   (-to64bitInt(value)) :
// >   (to64bitInt(value) | 0x8000000000000000)
//
// Since the float64 sign bit is the first bit (http://2ality.com/2012/04/number-encoding.html),
// we will only encounter this when we use more than 1 << 23 terms,
// that is why we changed our limit testing to 1 << 23 (8M+), if we fix this sorting case (is inverting the score bits? when negative enough?)
// we can change this limit to 1 << 24 (16M+) again.


// Fetch a score and docId as object from a key (Number)
function getScoreDocId(key) {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, key);
  return {
    score: dv.getUint8(3),
    docId: dv.getUint32(4)
  };
}

// Create a key (Number) from a termId, score and docId
function getKey(termId, score, docId) {
  const dv = new DataView(new ArrayBuffer(8));
  if (termId < 0 || score < 0 || docId < 0 || termId >= 1 << 23 || score >= 1 << 8 || docId >= (1 << 30) * 4) {
    throw Error('getKey out of bound');
  }
  dv.setUint32(0, termId << 8 | score);
  dv.setUint32(4, docId);
  return dv.getFloat64(0);
}

// Return the KeyRange inclusive bound to include all termId records
function getBound(termId) {
  const dv = new DataView(new ArrayBuffer(8));
  if (termId < 0 || termId >= 1 << 23) {
    throw Error('getBound out of bound');
  }
  dv.setUint32(0, termId << 8);
  dv.setUint32(4, 0);
  const lower = dv.getFloat64(0);

  dv.setUint32(0, termId << 8 | 0xFF);
  dv.setUint32(4, 0xFFFFFFFF);

  const upper = dv.getFloat64(0);
  return IDBKeyRange.bound(lower, upper, true, true);
}

async function addIndex(transaction, docId, terms) {
  const uniqueTerms = new Map();
  for (let i = 0; i < terms.length; i++) {
    uniqueTerms.set(terms[i], (uniqueTerms.get(terms[i]) || 0) + 1);
  }
  const store = transaction.objectStore(dbStoreIndex);
  const requests = [];
  for(const [term, count] of uniqueTerms) {
    //NOTE: we are using the tf after removing the stop words and ignoring them in the term count
    // explanation by example:
    // should a document with 'the the the the world' have a different tf than 'world'?
    // at the moment, they will have the same tf for world
    requests.push(store.put(null, getKey(await termCache.getIdAndIncreaseDf(transaction, term), getScaledBm15(count, terms.length), docId)));
  }
  await Promise.all(requests);
  return uniqueTerms.size;
}

// If documentsWithTerm = 0 then the result will be Infinity
function idf(documentCount, documentsWithTerm) {
  return Math.log(documentCount / documentsWithTerm);
}

async function getDocCount(transaction) {
  const count = await transaction.objectStore(dbStoreDocs).count();
  return count;
}

async function getTermCount(transaction) {
 const count = await transaction.objectStore(dbStoreTerms).count();
 return count;
}

async function query(term, limit = 10) {
  const documents = [];
  const transaction = (await db()).transaction([dbStoreIndex, dbStoreDocs, dbStoreTerms], dbRO);
  const termObj = await termCache.get(transaction, term);
  if (!termObj) {
    return {idf: 0, total: 0, documents};
  }
  const docCount = await getDocCount(transaction);
  // Since large tf's are stored as high numbers, we can only early stop when we walk in reverse (prev) order.
  let result;
  transaction.objectStore(dbStoreIndex).iterateCursor(getBound(termObj.id), 'prev', cursor => {
    if (cursor && documents.length < limit) {
      documents.push(getScoreDocId(cursor.key));
      cursor.continue();
    } else {
      result = {
        idf: idf(docCount, termObj.count),
        total: termObj.count,
        documents
      };
    }
  });
  return transaction.complete.then(() => result);
}

function tokenize(text) {
  // NOTE: since our stop words have the ' (single quote) removed, remove it here too for now
  const tokens = text.toLowerCase().replace(/'/g, '').split(/[^\w'-]+/);
  // remove last token if it is empty, this can happen if the string ends with a non-word.
  if (tokens[tokens.length - 1].length === 0) {
    tokens.pop();
  }
  return tokens;
}

export async function documentCount() {
  return getDocCount((await db()).transaction([dbStoreDocs], dbRO));
}

export async function batchAdd(texts, prefill = true) {
  const transaction = (await db()).transaction([dbStoreIndex, dbStoreDocs, dbStoreTerms], dbRW);
  if (prefill) {
    termCache.prefill(transaction);
  }
  for (let i = 0; i < texts.length; i++) {
    await add(texts[i], transaction);
  }
  await termCache.storeUpdatesToDB(transaction);
}

// Can add a document with {text: string, [id: Number]}, where id should be unique
export async function add(doc, transaction) {
  if (!doc.text || typeof doc.text !== 'string') {
    throw Error('Please include a text string');
  }
  const batch = transaction !== undefined;
  if (!transaction) {
    transaction = (await db()).transaction([dbStoreIndex, dbStoreDocs, dbStoreTerms], dbRW);
  }
  // tokenize, apply stemmer & remove stop words:
  const terms = tokenize(doc.text).map(stemmer).filter(term => !stopwords.has(term));
  const docId = await addDocRef(transaction, doc);
  const uniqueTermCount = await addIndex(transaction, docId, terms);
  if (!batch) {
    return termCache.storeUpdatesToDB(transaction).then(() => uniqueTermCount);
  }
  return uniqueTermCount;
}

export async function searchSingleWord(word, limit) {
  if (typeof word !== 'string') {
    throw Error('Please provide one word as a string');
  }
  // tokenize, apply stemmer & remove stop words:
  const tokens = tokenize(word);
  if (tokens.length !== 1) {
    throw Error('searchSingleWord only allows for a single word search, tokens found: ["' + tokens.join('", "') + '"]');
  }
  const terms = tokens.map(stemmer).filter(term => !stopwords.has(term));
  if (terms.length !== 1) {
    throw Error('the search word was a stop word');
  }
  return await query(terms[0], limit);
}