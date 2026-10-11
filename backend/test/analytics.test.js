'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { loadConfig } = require('../src/config');
const { createAdapters } = require('../src/adapters');
const { createCatalogue } = require('../src/services/catalogue');
const { createStoreNavigation } = require('../src/services/storeNavigation');
const { createStaffTasks } = require('../src/services/staffTasks');
const { createAnalytics, PII_FIELDS } = require('../src/services/analytics');

const STORE = require('../data/store.json');

function build() {
  const adapters = createAdapters(loadConfig({}));
  const catalogue = createCatalogue({ firestore: adapters.firestore });
  const storeNavigation = createStoreNavigation({ firestore: adapters.firestore, catalogue });
  const staffTasks = createStaffTasks({ firestore: adapters.firestore, catalogue, storeNavigation });
  const analytics = createAnalytics({ bigquery: adapters.bigquery, staffTasks, store: STORE });
  return { analytics, staffTasks };
}

test('emitted events are privacy-protected: PII fields are stripped, privacy stamped', async () => {
  const { analytics } = build();
  const event = await analytics.emit({
    type: 'intent',
    occasion: 'beach',
    // PII that MUST be stripped:
    name: 'Jane Doe',
    email: 'jane@example.com',
    phone: '+60123456789',
    userId: 'real-user-123',
    photoRef: 'gs://bucket/jane.png',
    anonUserId: 'anon-xyz',
  });

  for (const field of PII_FIELDS) {
    assert.ok(!(field in event), `event must not contain PII field "${field}"`);
  }
  assert.strictEqual(event.privacy.pii, false);
  assert.strictEqual(event.privacy.aggregationReady, true);
  assert.strictEqual(event.occasion, 'beach', 'non-PII dimensions are retained');
  assert.strictEqual(event.anonUserId, 'anon-xyz', 'anonymous bucket id is allowed');
});

test('sanitize never leaks a PII field even if nested-looking keys are passed', async () => {
  const { analytics } = build();
  const clean = analytics.sanitize({ occasion: 'work', email: 'x@y.z', creditCard: '4111' });
  assert.ok(!('email' in clean));
  assert.ok(!('creditCard' in clean));
  assert.strictEqual(clean.occasion, 'work');
  assert.strictEqual(clean.privacy.pii, false);
});

test('F13 retail dashboard returns all five aggregated sections, privacy-protected', async () => {
  const { analytics } = build();
  const dash = await analytics.retailDashboard();
  assert.strictEqual(dash.dashboard, 'retail-intelligence');
  assert.strictEqual(dash.privacy.pii, false);
  assert.strictEqual(dash.privacy.aggregationReady, true);

  const s = dash.sections;
  assert.strictEqual(s.shoppingIntent.title, 'Shopping Intent');
  assert.strictEqual(s.productDemand.title, 'Product Demand');
  assert.strictEqual(s.unmetDemand.title, 'Unmet Demand');
  assert.strictEqual(s.inStoreExperience.title, 'In-Store Experience');
  assert.strictEqual(s.commercialPerformance.title, 'Commercial Performance');

  assert.ok(Array.isArray(s.shoppingIntent.popularOccasions) && s.shoppingIntent.popularOccasions.length >= 1);
  assert.ok(Array.isArray(s.unmetDemand.reasons) && s.unmetDemand.reasons.length >= 1);
});

test('F14 staff dashboard surfaces picking requests + fitting-room availability', async () => {
  const { analytics, staffTasks } = build();
  await staffTasks.submitTask({ garments: [{ sku: 'TOP-OXF-004', size: 'M', colour: 'blue' }] });
  const dash = await analytics.staffDashboard();
  assert.strictEqual(dash.dashboard, 'staff-operations');
  assert.ok(dash.incomingPickingRequests.length >= 1);
  const req = dash.incomingPickingRequests[0];
  assert.strictEqual(req.garments[0].sku, 'TOP-OXF-004');
  assert.ok(req.garments[0].location, 'includes mapped rack location');
  assert.ok(dash.fittingRoomAvailability.length >= 1);
});

test('F15 merchandising insights are labelled HUMAN decision-support, not auto-reorder/forecast', async () => {
  const { analytics } = build();
  const dash = await analytics.merchandisingInsights();
  assert.strictEqual(dash.dashboard, 'merchandising-insights');

  assert.strictEqual(dash.decisionSupport.decisionSupport, true);
  assert.strictEqual(dash.decisionSupport.guaranteedForecast, false);
  assert.strictEqual(dash.decisionSupport.autoReorder, false);
  assert.match(dash.decisionSupport.note, /NOT guaranteed forecasts/);
  assert.match(dash.decisionSupport.note, /NOT automatic instructions to reorder/);

  // Each insight carries the decision-support interpretation.
  for (const key of Object.keys(dash.insights)) {
    assert.strictEqual(dash.insights[key].interpretation, 'decision-support');
    assert.ok(dash.insights[key].label);
  }
});
