import {memoizingStemmer as stemmer} from 'porter-stemmer';
import {english} from 'stopwords';

var db;
var docCount;
var stopwords = new Set(english);
const dbName = 'search-v1';
const dbStoreDocs = 'docs';
const dbStoreIndex = 'index';
const dbRO = 'readonly';
const dbRW = 'readwrite';

//TODO: recover from weird DB states, probably best to first make a delete/clear all method

function dbOpen(name) {
  return new Promise((resolve, reject) => {
    if (db) {
      return resolve(db);
    }
    let request = indexedDB.open(name, 1);
    request.onblocked = () => reject('update blocked by db open in other tab');
    request.onerror = () => reject('DB open error, maybe running in private/incognito mode?');
    request.onsuccess = event => { db = event.target.result; resolve(db); };
    request.onupgradeneeded = event => {
      db = event.target.result;
      db.createObjectStore(dbStoreIndex);
      db.createObjectStore(dbStoreDocs, {autoIncrement: true});
    };
  });
}

function dbAddDocRef(doc) {
  return dbOpen(dbName)
  .then(() => {
    return new Promise((resolve, reject) => {
      let autoId;
      let transaction = db.transaction([dbStoreDocs], dbRW);
      transaction.oncomplete = () => resolve(autoId);
      transaction.onerror = event => reject('transaction error when adding document', event);
      let store = transaction.objectStore(dbStoreDocs);
      let extract = doc.text.substring(0, 64);
      let request = doc.id ? store.add(extract, doc.id) : store.add(extract);
      request.onsuccess = event => { 
        autoId = event.target.result;
        if (docCount) {
          docCount++;
        }
      };
    })
  });
}

function dbAddIndex(docId, terms, start) {
  return dbOpen(dbName)
  .then(() => {
    return new Promise((resolve, reject) => {
      let uniqueTerms = new Map();
      for (var i = 0; i < terms.length; i++) {
        uniqueTerms.set(terms[i], (uniqueTerms.get(terms[i]) || 0) + 1);
      }
      let transaction = db.transaction([dbStoreIndex], dbRW);
      transaction.oncomplete = () => resolve({time: Date.now() - start, uniqueTerms: uniqueTerms.size});
      transaction.onerror = event => reject('transaction error when adding index', event);
      let store = transaction.objectStore(dbStoreIndex);
      uniqueTerms.forEach((count, term) => {
        //NOTE: we are using the tf after removing the stopwords and ignoring them in the term count
        // explaination by example:
        // should a document with 'the the the the world' have a different tf than 'world'?
        // at the moment, they will have the same tf for world
        let request = store.get(term);
        let tf = count / terms.length;
        request.onsuccess = event => {
          if (event.target.result) {
            event.target.result.push({id: docId.id, tf: tf});
            store.put(event.target.result, term);
          } else {
            store.add([{id: docId, tf: tf}], term);
          }
        }
      });
    })
  });
}

// If documentsWithTerm = 0 then the result will be Infitiny
function idf(documentCount, documentsWithTerm) {
  return Math.log(documentCount / documentsWithTerm);
}

function dbGetDocCount(transaction) {
  return new Promise((resolve, reject) => {
    if (docCount) {
      return resolve(docCount);
    }
    let request = transaction.objectStore(dbStoreDocs).count();
    request.onsuccess = event => {
      docCount = event.target.result;
      resolve(docCount);
    };
    request.onerror = () => reject('error getting the document count');
  });
}

function dbQuery(term, limit, start) {
  return dbOpen(dbName)
  .then(() => {
    return new Promise((resolve, reject) => {
      let transaction = db.transaction([dbStoreIndex, dbStoreDocs], dbRO);
      transaction.onerror = event => reject('transaction error when reading index', event);
      let request = transaction.objectStore(dbStoreIndex).get(term);
      request.onsuccess = event => {
        let results = event.target.result;
        // inverse sort on tf (large = index 0)
        results.sort((a, b) => b.tf - a.tf);
        dbGetDocCount(transaction)
        .then(() => resolve({
          idf: idf(docCount, results.length),
          total: results.length,
          results: results.splice(0, limit || 10),
          time: Date.now() - start
        }))
        .catch(event => reject(event));
      };
    });
  });
}

function tokenize(text) {
  // NOTE: since our stopwords have the ' (single quote) removed, remove it here too for now
  let tokens = text.toLowerCase().replace(/'/g, '').split(/[^\w'-]+/);
  // remove last token if it is empty, this can happen if the string ends with a non-word.
  if (tokens[tokens.length - 1].length === 0) {
    tokens.pop();
  }
  return tokens;
}

// Can add a document with {text: string, [id: Number]}, where id should be unique
export function add(doc) {
  let start = Date.now();
  return new Promise((resolve, reject) => {
    if (!doc.text || typeof doc.text !== 'string') {
      return reject('please include a text string');
    }
    // tokenize, apply stemmer & remove stopwords:
    var tokens = tokenize(doc.text);
    var terms = tokens.map(stemmer);
    resolve(terms.filter(term => !stopwords.has(term)));
  })
  .then(terms => dbAddDocRef(doc)
    .then(docId => { return {docId: docId, terms: terms}; })
  )
  .then(tuple => dbAddIndex(tuple.docId, tuple.terms, start));
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
    terms = terms.filter(term => !stopwords.has(term))
    if (terms.length !== 1) {
      return reject('the search word was a stopword');
    }
    resolve(terms[0]);
  })
  .then(term => dbQuery(term, limit, start));
}