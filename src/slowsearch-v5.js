import {memoizingStemmer as stemmer} from 'porter-stemmer';
import {english} from 'stopwords';
import {default as Promise} from 'es6-promise/lib/es6-promise/promise.js';

const stopwords = new Set(english);
const dbName = 'search-v5';
const dbStoreDocs = 'docs';
const dbStoreIndex = 'index';
const dbStoreTerms = 'terms';
const dbRO = 'readonly';
const dbRW = 'readwrite';

/* eslint-disable no-console */

//TODO: recover from weird DB states, probably best to first make a delete/clear all method

// is storing one tie for terms with word count & index faster / more space efficient?

let _db;
function db() {
  return new Promise((resolve, reject) => {
    if (_db) {
      return resolve(_db);
    }
    let request = indexedDB.open(dbName, 1);
    request.onblocked = () => reject('update blocked by db open in other tab');
    request.onerror = () => reject('DB open error, maybe running in private/incognito mode?');
    request.onsuccess = event => { _db = event.target.result; resolve(_db); };
    request.onupgradeneeded = event => {
      let db = event.target.result;
      db.createObjectStore(dbStoreIndex);
      db.createObjectStore(dbStoreDocs, {autoIncrement: true});
      db.createObjectStore(dbStoreTerms);
    };
  });
}

export function close() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

function addDocRef(transaction, doc) {
  return new Promise(resolve => {
    let request = transaction.objectStore(dbStoreDocs).add(doc.text.substring(0, 64), doc.id);
    request.onsuccess = event => {
      resolve(event.target.result);
    };
  });
}

const termCache = (() => {
  let cache = new Map();
  let cacheEqualsObjectStore = false;
  const inserts = new Set();
  const queue = new Map();

  function get(transaction, term) {
    let store = false;
    return new Promise(resolve => {
      const value = cache.get(term);
      if (value || cacheEqualsObjectStore) {
        return resolve(value);
      }
      store = true;
      let request = transaction.objectStore(dbStoreTerms).get(term);
      request.onsuccess = event => resolve(event.target.result);
    }).then(value => {
      if (store) {
        cache.set(term, value);
      }
      return value;
    });
  }

  function prefill(transaction) {
    return new Promise(resolve => {
      if (cacheEqualsObjectStore) {
        return resolve();
      }
      const request = transaction.objectStore(dbStoreTerms).openCursor();
      request.onsuccess = event => {
        const cursor = event.target.result;
        if (!cursor) {
          cacheEqualsObjectStore = true;
          return resolve();
        }
        cache.set(cursor.key, cursor.value);
        cursor.continue();
      };
    });
  }

  function getIdAndIncreaseDf(transaction, term) {
    let termObj;
    return Promise.resolve(null).then(() => {
      termObj = queue.get(term);
      if (!termObj) {
        return get(transaction, term);
      }
      return termObj;
    }).then(_termObj => {
      termObj = _termObj;
      if (!termObj) {
        return getTermCount(transaction);
      }
    }).then(termCount => {
      if (!termObj) {
        termObj = {id: inserts.size + termCount, count: 0};
        inserts.add(term);
      }
      termObj.count++;
      queue.set(term, termObj);
      return termObj.id;
    });
  }

  function discardUpdates() {
    inserts.clear();
    queue.clear();
  }

  function storeUpdatesToDB(transaction) {
    const newCache = new Map(cache);
    const store = transaction.objectStore(dbStoreTerms);
    for(const [term, value] of queue) {
      inserts.has(term) ? store.add(value, term) : store.put(value, term);
      newCache.set(term, value);
    }
    cache = newCache;
    inserts.clear();
    queue.clear();
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

function addIndex(transaction, docId, terms) {
  const uniqueTerms = new Map();
  for (let i = 0; i < terms.length; i++) {
    uniqueTerms.set(terms[i], (uniqueTerms.get(terms[i]) || 0) + 1);
  }
  const store = transaction.objectStore(dbStoreIndex);
  const promises = [];
  for(const [term, count] of uniqueTerms) {
    //NOTE: we are using the tf after removing the stop words and ignoring them in the term count
    // explanation by example:
    // should a document with 'the the the the world' have a different tf than 'world'?
    // at the moment, they will have the same tf for world
    promises.push(termCache.getIdAndIncreaseDf(transaction, term).then(id => {
      store.put(null, getKey(id, getScaledBm15(count, terms.length), docId));
    }));
  }
  return Promise.all(promises).then(() => { return uniqueTerms.size; });
}

// If documentsWithTerm = 0 then the result will be Infinity
function idf(documentCount, documentsWithTerm) {
  return Math.log(documentCount / documentsWithTerm);
}

function getDocCount(transaction) {
  return new Promise(resolve => {
    let request = transaction.objectStore(dbStoreDocs).count();
    request.onsuccess = event => resolve(event.target.result);
  });
}

function getTermCount(transaction) {
  return new Promise(resolve => {
    let request = transaction.objectStore(dbStoreTerms).count();
    request.onsuccess = event => resolve(event.target.result);
  });
}

function query(term, limit = 10) {
  let termObj, docCount, transaction;
  const documents = [];
  return db().then(dbval => {
    transaction = dbval.transaction([dbStoreIndex, dbStoreDocs, dbStoreTerms], dbRO);
    return termCache.get(transaction, term);
  }).then(_termObj => {
    termObj = _termObj;
    return getDocCount(transaction);
  }).then(_docCount => {
    docCount = _docCount;
    // Since large tf's are stored as high numbers, we can only early stop when we walk in reverse (prev) order.
    return new Promise(resolve => {
      if (!termObj) {
        return resolve({idf: 0, total: 0, documents: []});
      }
      const request = transaction.objectStore(dbStoreIndex).openCursor(getBound(termObj.id), 'prev');
      request.onsuccess = event => {
        const cursor = event.target.result;
        if (cursor && documents.length < limit) {
          documents.push(getScoreDocId(cursor.key));
          cursor.continue();
        } else {
          resolve({
            idf: idf(docCount, termObj.count),
            total: termObj.count,
            documents
          });
        }
      };
    });
  });
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
  return db().then(dbval => 
    getDocCount(dbval.transaction([dbStoreDocs], dbRO))
  );
}

export function batchAdd(texts, prefill = true) {
  let transaction;
  return db().then(dbval => {
    transaction = dbval.transaction([dbStoreIndex, dbStoreDocs, dbStoreTerms], dbRW);
    if (prefill) {
      return termCache.prefill(transaction);
    }
    return;
  }).then(() =>
    Promise.all(texts.map(text => add(text, transaction)))
  ).then(() => {
    termCache.storeUpdatesToDB(transaction);
    return new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = reject;
    });
  });
}

// Can add a document with {text: string, [id: Number]}, where id should be unique
function addInternal(doc, transaction) {
  let terms;
  return new Promise((resolve, reject) => {
    if (!doc.text || typeof doc.text !== 'string') {
      return reject('Please include a text string');
    }
    // tokenize, apply stemmer & remove stop words:
    terms = tokenize(doc.text).map(stemmer).filter(term => !stopwords.has(term));
    resolve(addDocRef(transaction, doc));
  }).then(docId => {
    // NOTE with 'native' FF Promises, we lost the transaction here, and the following call to
    // transaction.objectStore will error in addIndex
    return addIndex(transaction, docId, terms);
  });
}

export function add(doc) {
  let transaction;
  return db().then(dbval => {
    transaction = dbval.transaction([dbStoreIndex, dbStoreDocs, dbStoreTerms], dbRW);
    return addInternal(doc, transaction);
  }).then(uniqueTermsCount => {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve(uniqueTermsCount);
      transaction.onerror = reject;
      termCache.storeUpdatesToDB(transaction);
    });
  });
}

export function searchSingleWord(word, limit) {
  return new Promise((resolve, reject) => {
    if (typeof word !== 'string') {
      return reject('Please provide one word as a string');
    }
    // tokenize, apply stemmer & remove stop words:
    const tokens = tokenize(word);
    if (tokens.length !== 1) {
      return reject('searchSingleWord only allows for a single word search, tokens found: ["' + tokens.join('", "') + '"]');
    }
    const terms = tokens.map(stemmer).filter(term => !stopwords.has(term));
    if (terms.length !== 1) {
      return reject('the search word was a stop word');
    }
    resolve(query(terms[0], limit));
  });
}