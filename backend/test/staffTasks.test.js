'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { loadConfig } = require('../src/config');
const { createAdapters } = require('../src/adapters');
const { createCatalogue } = require('../src/services/catalogue');
const { createStoreNavigation } = require('../src/services/storeNavigation');
const { createStaffTasks, TASK_STATES } = require('../src/services/staffTasks');

function build() {
  const adapters = createAdapters(loadConfig({}));
  const catalogue = createCatalogue({ firestore: adapters.firestore });
  const storeNavigation = createStoreNavigation({ firestore: adapters.firestore, catalogue });
  let n = 0;
  const staffTasks = createStaffTasks({
    firestore: adapters.firestore,
    catalogue,
    storeNavigation,
    idgen: () => `task-test-${(++n)}`,
  });
  return { staffTasks };
}

test('submit enriches garments with name, availability, and mapped rack location', async () => {
  const { staffTasks } = build();
  const task = await staffTasks.submitTask({
    userId: 'anon-1',
    garments: [{ sku: 'TOP-OXF-004', size: 'M', colour: 'blue' }],
  });
  assert.strictEqual(task.status, TASK_STATES.SUBMITTED);
  assert.strictEqual(task.garments.length, 1);
  const g = task.garments[0];
  assert.strictEqual(g.sku, 'TOP-OXF-004');
  assert.ok(g.name, 'resolves product name from catalogue');
  assert.strictEqual(typeof g.available, 'boolean');
  assert.ok(g.location && g.location.rack === 'Rack B-17', 'maps rack location');
  assert.match(task.customerStatus, /sent to a store associate/i);
});

test('unknown SKU is never fabricated as available', async () => {
  const { staffTasks } = build();
  const task = await staffTasks.submitTask({ garments: [{ sku: 'NOPE-000', size: 'M' }] });
  assert.strictEqual(task.garments[0].available, false);
});

test('happy-path lifecycle: submit -> accept -> prepare -> ready for collection -> complete', async () => {
  const { staffTasks } = build();
  const submitted = await staffTasks.submitTask({ garments: [{ sku: 'TOP-OXF-004', size: 'M' }] });

  const accepted = await staffTasks.accept(submitted.id, { staffId: 'u-associate-001' });
  assert.strictEqual(accepted.status, TASK_STATES.ACCEPTED);
  assert.strictEqual(accepted.assignedTo, 'u-associate-001');
  assert.match(accepted.customerStatus, /accepted/i);

  const preparing = await staffTasks.prepare(submitted.id);
  assert.strictEqual(preparing.status, TASK_STATES.PREPARING);
  assert.match(preparing.customerStatus, /preparing/i);

  const ready = await staffTasks.prepare(submitted.id, { fittingRoomId: 'fr-l2-01' });
  assert.strictEqual(ready.status, TASK_STATES.READY_FOR_COLLECTION);
  assert.match(ready.customerStatus, /ready for collection/i);

  const done = await staffTasks.complete(submitted.id);
  assert.strictEqual(done.status, TASK_STATES.COMPLETED);
});

test('staff can reject a submitted task and the reason propagates to the customer', async () => {
  const { staffTasks } = build();
  const submitted = await staffTasks.submitTask({ garments: [{ sku: 'TOP-OXF-004', size: 'M' }] });
  const rejected = await staffTasks.reject(submitted.id, { reason: 'items_unavailable' });
  assert.strictEqual(rejected.status, TASK_STATES.REJECTED);
  assert.match(rejected.customerStatus, /could not fulfil/i);
  assert.match(rejected.customerStatus, /items_unavailable/);
});

test('illegal transitions are rejected', async () => {
  const { staffTasks } = build();
  const submitted = await staffTasks.submitTask({ garments: [{ sku: 'TOP-OXF-004', size: 'M' }] });
  // Cannot prepare before accept.
  await assert.rejects(() => staffTasks.prepare(submitted.id), /cannot prepare/i);
  await staffTasks.accept(submitted.id);
  // Cannot accept twice.
  await assert.rejects(() => staffTasks.accept(submitted.id), /cannot accept/i);
  // Cannot complete before ready.
  await assert.rejects(() => staffTasks.complete(submitted.id), /cannot complete/i);
  // Unknown task.
  await assert.rejects(() => staffTasks.accept('does-not-exist'), /not found/i);
});
