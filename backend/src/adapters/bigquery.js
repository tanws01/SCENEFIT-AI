'use strict';

/**
 * BigQuery adapter (analytics warehouse).
 *
 * Mock mode accepts inserted rows in memory and answers a fixed set of named
 * aggregate queries deterministically from the seeded analytics events, so the
 * retailer / merchandising dashboards work offline. Live mode is a TODO stub.
 */

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

function readEvents() {
  const full = path.join(DATA_DIR, 'analyticsEvents.json');
  const raw = fs.readFileSync(full, 'utf8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : (parsed.events || []);
}

/**
 * @param {{mode?: 'mock'|'live', config?: object}} [opts]
 */
function createBigQuery(opts = {}) {
  const mode = opts.mode === 'live' ? 'live' : 'mock';

  if (mode === 'live') {
    return {
      mode,
      async insertRows() { return liveNotImplemented('insertRows'); },
      async query() { return liveNotImplemented('query'); },
    };
  }

  /** @type {Map<string, object[]>} */
  const tables = new Map();

  function tableRows(table) {
    if (!tables.has(table)) tables.set(table, []);
    return tables.get(table);
  }

  // Named deterministic aggregate queries over seeded events.
  const NAMED_QUERIES = {
    // Count of intents grouped by occasion.
    'intent-by-occasion': () => {
      const events = readEvents().filter((e) => e.type === 'intent');
      return groupCount(events, (e) => (e.occasion || 'unspecified'));
    },
    // Most requested styles (demand signal).
    'demand-by-style': () => {
      const events = readEvents().filter((e) => e.type === 'demand');
      return groupCount(events, (e) => (e.style || 'unspecified'));
    },
    // Unmet demand: requests that could not be fulfilled (e.g. no 3 outfits).
    'unmet-demand': () => {
      const events = readEvents().filter((e) => e.type === 'unmet_demand');
      return groupCount(events, (e) => (e.reason || 'unspecified'));
    },
    // In-store engagement by zone.
    'in-store-by-zone': () => {
      const events = readEvents().filter((e) => e.type === 'in_store');
      return groupCount(events, (e) => (e.zone || 'unspecified'));
    },
    // Commercial: conversions / checkout handoffs.
    'commercial-summary': () => {
      const events = readEvents().filter((e) => e.type === 'commercial');
      const total = events.reduce((sum, e) => sum + (Number(e.valueRm) || 0), 0);
      return [{ metric: 'checkout_handoffs', count: events.length, totalValueRm: Number(total.toFixed(2)) }];
    },
  };

  return {
    mode,
    /**
     * @param {string} table
     * @param {object[]} rows
     */
    async insertRows(table, rows) {
      const list = Array.isArray(rows) ? rows : [rows];
      tableRows(table).push(...list.map((r) => JSON.parse(JSON.stringify(r))));
      return { table, inserted: list.length, source: 'bigquery-mock' };
    },
    /**
     * Run a named deterministic aggregate query.
     * @param {string} name
     * @returns {Promise<object[]>}
     */
    async query(name) {
      const fn = NAMED_QUERIES[name];
      if (!fn) {
        throw new Error(`bigquery mock: unknown named query "${name}"`);
      }
      return fn();
    },
    /** Expose the set of supported named queries. */
    namedQueries: Object.keys(NAMED_QUERIES),
  };
}

function groupCount(events, keyFn) {
  const counts = new Map();
  for (const e of events) {
    const key = keyFn(e);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key)));
}

function liveNotImplemented(method) {
  // TODO(live): Call Google BigQuery.
  //   Env vars: GOOGLE_CLOUD_PROJECT, BIGQUERY_DATASET.
  //   Lazy require: const { BigQuery } = require('@google-cloud/bigquery');
  throw new Error(
    `bigquery live mode not implemented in MVP (method: ${method}). ` +
    'Configure BIGQUERY_MODE=live with Google BigQuery credentials.'
  );
}

module.exports = { createBigQuery };
