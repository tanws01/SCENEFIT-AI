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
    // Shopping intent grouped by entry point (style-my-moment vs explore).
    'intent-by-entrypoint': () => {
      const events = readEvents().filter((e) => e.type === 'intent');
      return groupCount(events, (e) => (e.entryPoint || 'unspecified'));
    },
    // Shopping intent grouped by budget band.
    'intent-by-budget': () => {
      const events = readEvents().filter((e) => e.type === 'intent');
      return groupCount(events, (e) => (e.budgetBand || 'unspecified'));
    },
    // Most requested styles (demand signal).
    'demand-by-style': () => {
      const events = readEvents().filter((e) => e.type === 'demand');
      return groupCount(events, (e) => (e.style || 'unspecified'));
    },
    // Most requested colours (demand signal).
    'demand-by-colour': () => {
      const events = readEvents().filter((e) => e.type === 'demand');
      return groupCount(events, (e) => (e.colour || 'unspecified'));
    },
    // Unmet demand: requests that could not be fulfilled (e.g. no 3 outfits).
    'unmet-demand': () => {
      const events = readEvents().filter((e) => e.type === 'unmet_demand');
      return groupCount(events, (e) => (e.reason || 'unspecified'));
    },
    // Unmet demand that is specifically a requested-but-unavailable size.
    'unmet-demand-by-size': () => {
      const events = readEvents().filter((e) => e.type === 'unmet_demand'
        && e.reason === 'size_out_of_stock' && e.requestedSize != null);
      return groupCount(events, (e) => `${e.sku || 'unspecified'} size ${e.requestedSize}`);
    },
    // In-store engagement by zone.
    'in-store-by-zone': () => {
      const events = readEvents().filter((e) => e.type === 'in_store');
      return groupCount(events, (e) => (e.zone || 'unspecified'));
    },
    // In-store funnel: lookups -> staff assist -> queue -> completed sessions.
    'in-store-funnel': () => {
      const events = readEvents().filter((e) => e.type === 'in_store');
      const stages = [
        ['Location lookups', 'rack_navigation_viewed'],
        ['Staff-assist requests', 'staff_assist_requested'],
        ['Fitting-room queue joins', 'fitting_room_queue_joined'],
        ['Completed fitting sessions', 'fitting_room_session_completed'],
      ];
      return stages.map(([label, action]) => ({
        key: label,
        count: events.filter((e) => e.action === action).length,
      }));
    },
    // Weekly event volume (time-series / trend across all event types).
    'events-by-week': () => weeklySeries(readEvents()),
    // Weekly demand-signal volume (trend of demand events only).
    'demand-by-week': () => weeklySeries(readEvents().filter((e) => e.type === 'demand')),
    // Commercial: a set of KPI metrics, computed deterministically.
    'commercial-summary': () => {
      const events = readEvents().filter((e) => e.type === 'commercial');
      const countOf = (action) => events.filter((e) => e.action === action).length;
      const valueOf = (action) => events
        .filter((e) => e.action === action)
        .reduce((sum, e) => sum + (Number(e.valueRm) || 0), 0);

      const recommendationsShown = countOf('recommendation_shown');
      const savedLooks = countOf('saved_look');
      const addToCart = countOf('add_to_cart');
      const tryOns = countOf('try_on');
      const checkoutHandoffs = countOf('checkout_handoff');
      const totalValueRm = Number((valueOf('checkout_handoff')).toFixed(2));
      const avgBasketRm = checkoutHandoffs
        ? Number((totalValueRm / checkoutHandoffs).toFixed(2))
        : 0;
      const conversionRate = recommendationsShown
        ? Number((checkoutHandoffs / recommendationsShown).toFixed(4))
        : 0;

      return [
        { metric: 'recommendations_shown', count: recommendationsShown, totalValueRm: 0 },
        { metric: 'saved_looks', count: savedLooks, totalValueRm: 0 },
        { metric: 'add_to_cart', count: addToCart, totalValueRm: Number(valueOf('add_to_cart').toFixed(2)) },
        { metric: 'try_on_events', count: tryOns, totalValueRm: 0 },
        { metric: 'checkout_handoffs', count: checkoutHandoffs, totalValueRm },
        { metric: 'avg_basket_rm', count: checkoutHandoffs, totalValueRm: avgBasketRm },
        { metric: 'conversion_rate', count: checkoutHandoffs, totalValueRm: conversionRate },
      ];
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

/**
 * Build a weekly time-series [{ key: weekStart, count }] ordered oldest-first,
 * so dashboards can draw a trend. Weeks come from each event's `week` field
 * (seeded) with a fallback to the ISO-week-start derived from the timestamp.
 */
function weeklySeries(events) {
  const counts = new Map();
  for (const e of events) {
    const key = e.week || weekStartOf(e.timestamp);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Monday-anchored ISO date (YYYY-MM-DD) for a timestamp. */
function weekStartOf(timestamp) {
  const d = new Date(timestamp || 0);
  if (Number.isNaN(d.getTime())) return 'unspecified';
  const day = (d.getUTCDay() + 6) % 7; // 0 = Monday
  d.setUTCDate(d.getUTCDate() - day);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
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
