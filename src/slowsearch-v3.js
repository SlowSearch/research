import {memoizingStemmer as stemmer} from 'porter-stemmer';
import {english} from 'stopwords';
import {idb} from 'idb';

const stopwords = new Set(english);
const dbName = 'search-v3';
const dbStoreDocs = 'docs';
const dbStoreIndex = 'index';
const dbStoreTerms = 'terms';
const dbRO = 'readonly';
const dbRW = 'readwrite';

//TODO: recover from weird DB states, probably best to first make a delete/clear all method

// 1: trie for terms with word count & index
// 3: cursor over binary


let _db;
async function db(name) {
  if (_db) {
    return _db;
  }
  _db = await idb.open(name, 1, upgradedb => {
    upgradedb.createObjectStore(dbStoreIndex, {autoIncrement: true});
    upgradedb.createObjectStore(dbStoreDocs, {autoIncrement: true});
    upgradedb.createObjectStore(dbStoreTerms);
  });
  return _db;
}

async function addDocRef(transaction, doc) {
  const docId = await transaction.objectStore(dbStoreDocs).add(doc.text.substring(0, 64), doc.id);
  return docId;
}

let termCache = {
  
  async function prefetchTermCache(transaction) {
    await transaction.objectStore(dbStoreTerms).íterateCursor(cursor => {
      if (!cursor) {
        return;
      }
      termIds.set(cursor.key, cursor.value);
      cursor.continue();
    });
  }
};

async function getTermObj(transaction, term) {
  let cache = termIds.get(term);
  if (cache) {
    return cache;
  }
  if 
async function resolveTerm(transaction, term, batch, value, resolve) {
  
  value.count++;
  if (batch) {
    value.updated = true;
  }
  termIds.set(term, value);
  resolve(value.id);
  if (!batch) {
    //ERROR /put/add
    transaction.objectStore(dbStoreTerms).add(term, value);
  }
}


  //get term, (if not exist, return count & put new) else return id update idf
  return new Promise(resolve => {
    
    if (!cache && (!batch || !batch.prefetched)) {
      transaction.objectStore(dbStoreTerms).get(term).onsuccess = event => {
        let value = event.target.result;
        if (!value) {
          dbGetTermCount(transaction).then(termCount => {
            value = {id: termCount++, count: 0};
            resolveTerm(transaction, term, batch, value, resolve);
          });
        } else {
          resolveTerm(transaction, term, batch, value, resolve);
        }
      };      
    } else if (!cache) {
      dbGetTermCount(transaction).then(termCount => {
        let value = {id: termCount++, count: 0};
        resolveTerm(transaction, term, batch, value, resolve);
      });
    } else {
      let value = cache;
      resolveTerm(transaction, term, batch, value, resolve);
    }
  });
}

function getTerm(transaction, term) {
  //get term, (if not exist, return count & put new) else return id update idf
  return new Promise(resolve => {
    let cache = termIds.get(term);
    if (!cache) {
      transaction.objectStore(dbStoreTerms).get(term).onsuccess = event => {
        let value = event.target.result;
        resolve(value);
        termIds.set(term, value);
      };      
    } else {
      resolve(cache);
    }
  });
}

//var getScaledTf = (termCount, docSize) => Math.floor(Math.sqrt(termCount / docSize) * 255);
//let bm25k1 = 1.2, bm25b = 0.75, bm25avg = 2000;
//var bm25 = (termCount,docSize,avg) => Math.floor(255 * ((termCount / docSize) * (bm25k1 + 1)) / (termCount / docSize + bm25k1 *(1 - bm25b + bm25b * (docSize / bm25avg))));

let bm15k1 = 1.2;//, bm15b = 0.75;
var getScaledBm15 = (termCount, docSize) => Math.floor(255 * ((termCount / docSize) * (bm15k1 + 1)) / (termCount / docSize + bm15k1));

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


function getTfDocId(key) {
  let dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, key);
  return {
    tf: dv.getUint8(3),
    docId: dv.getUint32(4)
  };
}

function getKey(termId, tf, docId) {
  let dv = new DataView(new ArrayBuffer(8));
  if (termId < 0 || tf < 0 || docId < 0 || termId >= 1 << 23 || tf >= 1 << 8 || docId >= (1 << 30) * 4) {
    return NaN;
  }
  dv.setUint32(0, termId << 8 | tf);
  dv.setUint32(4, docId);
  return dv.getFloat64(0);
}

function getBounds(termId) {
  let dv = new DataView(new ArrayBuffer(8));
  if (termId < 0 || termId >= 1 << 23) {
    return NaN;
  }
  dv.setUint32(0, termId << 8);
  dv.setUint32(4, 0);
  let lower = dv.getFloat64(0);

  dv.setUint32(0, termId << 8 | 0xFF);
  dv.setUint32(4, 0xFFFFFFFF);

  let upper = dv.getFloat64(0);
  return IDBKeyRange.bounds(lower, upper, true, true);
}


function dbAddIndex(transaction, docId, terms, start, batch) {
  return new Promise(resolve => {
    let uniqueTerms = new Map();
    for (let i = 0; i < terms.length; i++) {
      uniqueTerms.set(terms[i], (uniqueTerms.get(terms[i]) || 0) + 1);
    }
    const store = transaction.objectStore(dbStoreIndex);
    uniqueTerms.forEach((count, term) => {
      //NOTE: we are using the tf after removing the stop words and ignoring them in the term count
      // explanation by example:
      // should a document with 'the the the the world' have a different tf than 'world'?
      // at the moment, they will have the same tf for world
      store.put(null, getKey(getTermIdAndIncreaseDf(transaction, term, batch), getScaledBm15(count, terms.length), docId));
    });
    resolve({time: Date.now() - start, uniqueTerms: uniqueTerms.size});
  });
}

// If documentsWithTerm = 0 then the result will be Infinity
function idf(documentCount, documentsWithTerm) {
  return Math.log(documentCount / documentsWithTerm);
}

function dbGetDocCount(transaction) {
  return new Promise(resolve => {
    if (docCount) {
      return resolve(docCount);
    }
    let request = transaction.objectStore(dbStoreDocs).count();
    request.onsuccess = event => {
      docCount = event.target.result;
      resolve(docCount);
    };
  });
}

function dbGetTermCount(transaction) {
  return new Promise(resolve => {
    if (termCount) {
      return resolve(termCount);
    }
    let request = transaction.objectStore(dbStoreTerms).count();
    request.onsuccess = event => {
      termCount = event.target.result;
      resolve(termCount);
    };
  });
}

function dbQuery(term, limit, start) {
  return dbOpen(dbName)
  .then((db) => {
    return new Promise((resolve, reject) => {
      let results = [];
      let transaction = db.transaction([dbStoreIndex, dbStoreDocs, dbStoreTerms], dbRO);
      transaction.onerror = event => reject('transaction error when reading index', event);
      getTerm(transaction, term).then(termObj => {
        if (!termObj) {
          return {idf: 0, total: results.length, results: results, time: Date.now() - start};
        }
        // Since large tf's are stored as high numbers, we can only early stop when we walk in reverse (prev) order.
        let request = transaction.objectStore(dbStoreIndex).openCursor(getBounds(termObj.id), 'prev');
        request.onsuccess = event => {
          let cursor = event.target.result;
          if (cursor && results.length < (limit || 10)) {
            results.push(getTfDocId(cursor.key));
            cursor.continue();
          } else {
            dbGetDocCount(transaction)
            .then(() => resolve({
              idf: idf(docCount, termObj.count),
              total: termObj.count,
              results: results,
              time: Date.now() - start
            }))
            .catch(event => reject(event));
          }
        };
      });
    });
  });
}

function tokenize(text) {
  // NOTE: since our stop words have the ' (single quote) removed, remove it here too for now
  let tokens = text.toLowerCase().replace(/'/g, '').split(/[^\w'-]+/);
  // remove last token if it is empty, this can happen if the string ends with a non-word.
  if (tokens[tokens.length - 1].length === 0) {
    tokens.pop();
  }
  return tokens;
}

export function batchAdd(texts, prefetch) {
  return dbOpen(dbName)
  .then((db) => {
    return new Promise((resolve, reject) => {
      let transaction = db.transaction([dbStoreIndex, dbStoreDocs, dbStoreTerms], dbRW);
      transaction.onerror = event => reject('transaction error', event);
      let batch = true;
      if (prefetch) {
        dbPrefetchTermCache(transaction);
        batch = {prefetched: true};
      }
      let promises = [];
      for (let i = 0; i < texts.length; i++) {
        promises.push(add(texts[i], transaction, batch));
      }
      return Promise.all(promises);
    });
  });
}

// Can add a document with {text: string, [id: Number]}, where id should be unique
export function add(doc, transaction, batch) {
  const start = Date.now();
  return dbOpen(dbName)
  .then(() => {
    return new Promise((resolve, reject) => {
      if (!doc.text || typeof doc.text !== 'string') {
        return reject('please include a text string');
      }
      if (!transaction) {
        transaction = db.transaction([dbStoreIndex, dbStoreDocs, dbStoreTerms], dbRW);
      }
      // tokenize, apply stemmer & remove stopwords:
      const tokens = tokenize(doc.text);
      const terms = tokens.map(stemmer);
      resolve(terms.filter(term => !stopwords.has(term)));
    })
    .then(terms => dbAddDocRef(transaction, doc)
      .then(docId => { return {docId: docId, terms: terms}; })
    )
    .then(tuple => dbAddIndex(transaction, tuple.docId, tuple.terms, start, batch));
  });
}

export function searchSingleWord(word, limit) {
  let start = Date.now();
  return new Promise((resolve, reject) => {
    if (typeof word !== 'string') {
      return reject('please provide one word as a string');
    }
    // tokenize, apply stemmer & remove stopwords:
    var tokens = tokenize(word);
    if (tokens.length !== 1) {
      return reject('this function only allows for a single word search, tokens found = ' + tokens.length);
    }
    var terms = tokens.map(stemmer);
    terms = terms.filter(term => !stopwords.has(term));
    if (terms.length !== 1) {
      return reject('the search word was a stopword');
    }
    resolve(terms[0]);
  })
  .then(term => dbQuery(term, limit, start));
}