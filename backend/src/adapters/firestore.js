'use strict';

/**
 * Firestore adapter (document database).
 *
 * Mock mode is an in-memory, deterministic document store seeded from the
 * backend/data/*.json files on first use. It supports get/set/query over
 * named collections. Live mode is a TODO stub that lazily requires the Google
 * Firestore SDK.
 *
 * NOTE: the mock holds authoritative seeded retail data (catalogue, inventory,
 * planogram, collections). The deterministic application services read from
 * here; Gemini never writes retail facts here.
 */

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

/** Map a logical collection name to a seed file (if any). */
const SEED_FILES = Object.freeze({
  retailers: 'retailer.json',
  stores: 'store.json',
  products: 'products.json',
  collections: 'collections.json',
  sizeCharts: 'sizeCharts.json',
  planogram: 'planogram.json',
  analyticsEvents: 'analyticsEvents.json',
  staffTasks: 'staffTasks.json',
  fittingRoomQueue: 'fittingRoomQueue.json',
});

function readSeed(file) {
  const full = path.join(DATA_DIR, file);
  const raw = fs.readFileSync(full, 'utf8');
  return JSON.parse(raw);
}

/**
 * Normalise a seed payload into an array of {id, ...} documents.
 * Seed files may be a single object or an array.
 */
function toDocuments(collectionName, payload) {
  if (Array.isArray(payload)) {
    return payload.map((doc, idx) => ({ id: doc.id || doc.sku || String(idx), ...doc }));
  }
  if (payload && typeof payload === 'object') {
    // A seed file keyed by id, or a single top-level record.
    if (payload.id || payload.sku) {
      return [{ id: payload.id || payload.sku, ...payload }];
    }
    // Treat as map of id -> doc.
    return Object.entries(payload).map(([id, doc]) => ({ id, ...doc }));
  }
  return [];
}

/**
 * @param {{mode?: 'mock'|'live', config?: object}} [opts]
 */
function createFirestore(opts = {}) {
  const mode = opts.mode === 'live' ? 'live' : 'mock';

  if (mode === 'live') {
    return {
      mode,
      async get() { return liveNotImplemented('get'); },
      async set() { return liveNotImplemented('set'); },
      async query() { return liveNotImplemented('query'); },
    };
  }

  /** @type {Map<string, Map<string, object>>} */
  const store = new Map();
  let seeded = false;

  function ensureSeeded() {
    if (seeded) return;
    for (const [collection, file] of Object.entries(SEED_FILES)) {
      const docs = toDocuments(collection, readSeed(file));
      const col = new Map();
      for (const doc of docs) col.set(String(doc.id), doc);
      store.set(collection, col);
    }
    seeded = true;
  }

  function col(name) {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name);
  }

  return {
    mode,
    /**
     * @param {string} collection
     * @param {string} id
     * @returns {Promise<object|null>}
     */
    async get(collection, id) {
      ensureSeeded();
      const found = col(collection).get(String(id));
      return found ? deepClone(found) : null;
    },
    /**
     * @param {string} collection
     * @param {string} id
     * @param {object} doc
     */
    async set(collection, id, doc) {
      ensureSeeded();
      const record = { id: String(id), ...doc };
      col(collection).set(String(id), deepClone(record));
      return deepClone(record);
    },
    /**
     * Query a collection with an optional predicate function.
     * @param {string} collection
     * @param {(doc:object)=>boolean} [predicate]
     * @returns {Promise<object[]>}
     */
    async query(collection, predicate) {
      ensureSeeded();
      const docs = Array.from(col(collection).values()).map(deepClone);
      return typeof predicate === 'function' ? docs.filter(predicate) : docs;
    },
  };
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function liveNotImplemented(method) {
  // TODO(live): Call Google Cloud Firestore.
  //   Env vars: GOOGLE_CLOUD_PROJECT, FIREBASE_PROJECT.
  //   Lazy require: const { Firestore } = require('@google-cloud/firestore');
  throw new Error(
    `firestore live mode not implemented in MVP (method: ${method}). ` +
    'Configure FIRESTORE_MODE=live with Google Cloud Firestore credentials.'
  );
}

module.exports = { createFirestore, SEED_FILES };
