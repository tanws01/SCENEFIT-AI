'use strict';

/**
 * Dashboard access + richer-analytics tests.
 *
 * TASK A: the three read-only dashboard VIEWS are OPEN - GET
 * /api/dashboard/retail, /staff, /merchandising return 200 + data with NO
 * Authorization header. The STATE-CHANGING operational endpoints
 * (staff-task accept/reject/prepare, queue confirm/advance) stay role-gated
 * and still reject an unauthenticated request with 401.
 *
 * TASK B: the expanded named queries, KPIs and weekly time-series are computed
 * correctly from the seeded (now much larger) event set, and the enlarged
 * event set still carries NO PII.
 *
 * Everything runs offline against the real exported server over an ephemeral
 * port (deterministic mock adapters).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { server } = require('../src/server');
const EVENTS = require('../data/analyticsEvents.json');
const { PII_FIELDS } = require('../src/services/analytics');

let baseUrl;

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function req(method, path, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const r = http.request(url, { method, headers: headers || {} }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let json = null;
        try { json = body ? JSON.parse(body) : null; } catch (_e) { /* leave null */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    r.on('error', reject);
    r.end();
  });
}

// ---- TASK A: open dashboard VIEWS -------------------------------------

test('GET /api/dashboard/retail returns 200 + data with NO auth header', async () => {
  const res = await req('GET', '/api/dashboard/retail');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.dashboard, 'retail-intelligence');
  assert.strictEqual(res.body.privacy.pii, false);
  assert.ok(res.body.sections && res.body.sections.shoppingIntent);
});

test('GET /api/dashboard/staff returns 200 + data with NO auth header', async () => {
  const res = await req('GET', '/api/dashboard/staff');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.dashboard, 'staff-operations');
  assert.ok(Array.isArray(res.body.incomingPickingRequests));
  assert.ok(res.body.operationsSummary);
});

test('GET /api/dashboard/merchandising returns 200 + data with NO auth header', async () => {
  const res = await req('GET', '/api/dashboard/merchandising');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.dashboard, 'merchandising-insights');
  assert.strictEqual(res.body.decisionSupport.guaranteedForecast, false);
  assert.strictEqual(res.body.decisionSupport.autoReorder, false);
});

// ---- TASK A: write/operational endpoints stay role-gated ---------------

test('POST /api/staff-task/:id/accept still requires auth (401 without token)', async () => {
  const res = await req('POST', '/api/staff-task/task-seed-0001/accept');
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.body.error, 'unauthenticated');
});

test('POST /api/queue/:id/confirm still requires auth (401 without token)', async () => {
  const res = await req('POST', '/api/queue/tkt-seed-0001/confirm');
  assert.strictEqual(res.status, 401);
});

test('POST /api/queue/:id/advance still requires auth (401 without token)', async () => {
  const res = await req('POST', '/api/queue/tkt-seed-0001/advance');
  assert.strictEqual(res.status, 401);
});

// ---- TASK B: richer analytics shapes + correctness ---------------------

test('retail dashboard exposes KPIs, weekly trends and richer breakdowns', async () => {
  const res = await req('GET', '/api/dashboard/retail');
  const d = res.body;

  // KPIs present and internally consistent.
  assert.ok(d.kpis);
  assert.strictEqual(d.kpis.totalEvents, EVENTS.length);
  assert.ok(d.kpis.recommendationsShown >= 1);
  assert.ok(d.kpis.checkoutHandoffs >= 1);
  assert.ok(d.kpis.avgBasketRm > 0);

  // Weekly time-series present and ordered oldest-first.
  const weeks = d.trends.eventsByWeek;
  assert.ok(weeks.length >= 2);
  for (let i = 1; i < weeks.length; i += 1) {
    assert.ok(weeks[i - 1].key <= weeks[i].key);
  }
  // The weekly totals sum to the overall total events.
  const summed = weeks.reduce((s, w) => s + w.count, 0);
  assert.strictEqual(summed, EVENTS.length);

  // Richer breakdowns surfaced.
  assert.ok(d.sections.shoppingIntent.byEntryPoint.length >= 1);
  assert.ok(d.sections.productDemand.mostRequestedColours.length >= 2);
  assert.strictEqual(d.sections.inStoreExperience.funnel.length, 4);
  assert.ok(d.sections.commercialPerformance.kpis.conversionRate >= 0);
});

test('conversion rate equals checkout handoffs / recommendations shown', async () => {
  const res = await req('GET', '/api/dashboard/retail');
  const k = res.body.sections.commercialPerformance.kpis;
  const expected = Number((k.checkoutHandoffs / k.recommendationsShown).toFixed(4));
  assert.strictEqual(k.conversionRate, expected);
});

test('staff board is busy: multiple tasks across statuses, rooms and queue tickets', async () => {
  const res = await req('GET', '/api/dashboard/staff');
  const d = res.body;
  assert.ok(d.incomingPickingRequests.length >= 4, 'several picking tasks');
  const statuses = new Set(d.incomingPickingRequests.map((t) => t.status));
  assert.ok(statuses.size >= 3, 'tasks span multiple statuses');
  assert.ok(d.fittingRoomAvailability.length >= 3, 'multiple fitting rooms');
  assert.ok(d.fittingRoomAvailability.every((r) => r.status), 'rooms carry a status');
  assert.ok(d.queueTickets.length >= 3, 'several queue tickets');
  assert.ok(d.operationsSummary.totalTasks >= 4);
});

test('the committed analyticsEvents.json matches the deterministic generator', () => {
  // The generator must reproduce the committed static file byte-for-byte, so
  // offline runs and tests stay stable (the server only reads the static file).
  const { build, serialise } = require('../data/generate-analytics');
  const regenerated = JSON.parse(serialise(build()));
  assert.deepStrictEqual(regenerated, EVENTS, 'generator output must equal committed seed');
});

test('the enlarged seeded event set carries NO PII', async () => {
  assert.ok(EVENTS.length >= 200, 'dataset is substantial');
  for (const ev of EVENTS) {
    for (const field of PII_FIELDS) {
      assert.ok(!(field in ev), `event ${ev.id} must not contain PII field "${field}"`);
    }
    assert.strictEqual(ev.privacy.pii, false);
    assert.strictEqual(ev.privacy.aggregationReady, true);
    if ('anonUserId' in ev) {
      assert.match(ev.anonUserId, /^anon-/, 'only an anonymised bucket id is allowed');
    }
  }
});
