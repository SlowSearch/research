Slowsearch

!(https://paper.treora.com/0/page62.svg)

!(https://paper.treora.com/0/page63.svg)

!(https://paper.treora.com/0/page64.svg)

# Definitions

tf is relative for the document (so 0-1)

term count is the document count for that term

# Models

## Base document model

We use a basic document store, which is not needed.

| name | key                   | value                      |
|:-----|:----------------------|:---------------------------|
| docs | autoIncrement: Number | {meta information}: Object |

## v1 model

| name  | key  | value                                            |
|:------|:-----|:-------------------------------------------------|
| index | term | [{docId: Number, tf: Number}: Object,...]: Array |

Pro:
* efficient storage
* query a term is only one record fetch
Con:
* insertion speed

## v2 model

| name  | key                   | value                                              |
|:------|:----------------------|:---------------------------------------------------|
| index | autoIncrement: Number | {term: string, docId: Number, tf*: Number}: Object |

And an (non unique) index on keyPath term.

Pro:

Con:

## v3 model

| name  | key                                                            | value                               |
|:------|:---------------------------------------------------------------|:------------------------------------|
| term  | term: string                                                   | {id: Number, count: Number}: Object |
| index | termId (3 bytes), score (1 byte), documentId (4 bytes): Number | null                                |

Pro:
* Trade of between storage and insert speed: only one record per term docId pair with terms being efficiently stored as just 3 bytes.
* Possibility of early stopping, because the index is sorted
Con:
* Complex model

# Code

v1: pure Promise
v2: pure Promise
v3: async/await + idb wrapper (which is Promise based)
v4: async/await + Promise (idb adds promises for our inserts that we don't care about, since we already have the transaction promise)
v5: pure Promises (removes async/await)
v6: [broken] callbacks
