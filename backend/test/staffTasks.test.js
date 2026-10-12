'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { loadConfig } = require('../src/config');
const { createAdapters } = require('../src/adapters');
const { createCatalogue } = require('../src/services/catalogue');
const { createStoreNavigation } = require('../src/services/storeNavigation');
const { createStaffTasks, TASK_STATES, COLLECTION: STAFF_COLLECTION } = require('../src/services/staffTasks');
const { createFittingRoomQueue, STATES } = require('../src/services/fittingRoomQueue');

const STORE = require('../data/store.json');

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

/**
 * Build staffTasks WITH a fitting-room queue injected, sharing the same
 * firestore adapter + a deterministic clock/idgen so history timestamps and
 * ids are stable across the task and queue services.
 * @param {object} [opts] { store } override the branch record
 */
function buildWithQueue(opts = {}) {
  const adapters = createAdapters(loadConfig({}));
  const catalogue = createCatalogue({ firestore: adapters.firestore });
  const storeNavigation = createStoreNavigation({ firestore: adapters.firestore, catalogue });
  const store = opts.store || STORE;
  let tick = 0;
  const now = () => new Date(2025, 0, 1, 0, 0, tick++).toISOString();
  let qn = 0;
  const fittingRoomQueue = createFittingRoomQueue({
    firestore: adapters.firestore,
    store,
    now,
    idgen: () => `tkt-test-${(++qn)}`,
  });
  let tn = 0;
  const staffTasks = createStaffTasks({
    firestore: adapters.firestore,
    catalogue,
    storeNavigation,
    fittingRoomQueue,
    store,
    now,
    idgen: () => `task-test-${(++tn)}`,
  });
  // Expose the shared firestore adapter so tests can seed task<->ticket links
  // deterministically (the services both read/write through this one adapter).
  return { staffTasks, fittingRoomQueue, store, firestore: adapters.firestore };
}

/** Submit -> accept -> prepare (Preparing) a task, returning its id. */
async function toPreparing(staffTasks) {
  const submitted = await staffTasks.submitTask({ userId: 'anon-1', garments: [{ sku: 'TOP-OXF-004', size: 'M', colour: 'blue' }] });
  await staffTasks.accept(submitted.id, { staffId: 'u-associate-001' });
  await staffTasks.prepare(submitted.id);
  return submitted.id;
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

test('ReadyForCollection auto-creates a linked queue ticket driven to Ready via the LEGAL path', async () => {
  const { staffTasks, fittingRoomQueue } = buildWithQueue();
  const taskId = await toPreparing(staffTasks);

  const ready = await staffTasks.prepare(taskId, { fittingRoomId: 'fr-l2-01' });
  assert.strictEqual(ready.status, TASK_STATES.READY_FOR_COLLECTION);
  assert.ok(ready.queueTicketId, 'task is linked to a queue ticket');

  const ticket = await fittingRoomQueue.get(ready.queueTicketId);
  assert.ok(ticket, 'linked ticket exists');
  assert.strictEqual(ticket.status, STATES.READY);
  assert.strictEqual(ticket.sourceTaskId, taskId, 'ticket backlinks to the task');
  assert.strictEqual(ticket.fittingRoomId, 'fr-l2-01', 'ticket carries the fitting room');

  // The ticket reached Ready via the exact legal chain, in order.
  const historyStates = ticket.history.map((h) => h.state);
  assert.deepStrictEqual(historyStates, [
    STATES.REQUESTED,
    STATES.CONFIRMED,
    STATES.PICKING_ITEMS,
    STATES.WAITING_FOR_ROOM,
    STATES.READY,
  ]);
});

test('ReadyForCollection advances an ALREADY-LINKED earlier-state ticket to Ready (no duplicate)', async () => {
  const { staffTasks, fittingRoomQueue, firestore } = buildWithQueue();
  const taskId = await toPreparing(staffTasks);

  // Baseline count of pre-seeded queue tickets (the firestore adapter seeds
  // fittingRoomQueue.json for the staff board).
  const baseline = (await fittingRoomQueue.list()).length;

  // Customer created a ticket earlier and left it at Picking Items (partway
  // along the legal chain).
  const created = await fittingRoomQueue.requestQueue({ userId: 'anon-1', items: [{ sku: 'TOP-OXF-004', size: 'M' }] });
  const existingId = created.ticket.id;
  await fittingRoomQueue.confirm(existingId);
  await fittingRoomQueue.advance(existingId, STATES.PICKING_ITEMS);

  // Link it onto the task so prepare() advances THIS ticket (persist via the
  // shared firestore adapter the services both read from).
  const task = await firestore.get(STAFF_COLLECTION, taskId);
  task.queueTicketId = existingId;
  await firestore.set(STAFF_COLLECTION, taskId, task);

  const ready = await staffTasks.prepare(taskId, { fittingRoomId: 'fr-l2-02' });
  assert.strictEqual(ready.queueTicketId, existingId, 'reuses the existing ticket');

  const ticket = await fittingRoomQueue.get(existingId);
  assert.strictEqual(ticket.status, STATES.READY);
  assert.strictEqual(ticket.sourceTaskId, taskId);

  // No duplicate ticket was created: only the one customer ticket beyond the
  // pre-seeded baseline exists (the linked ticket was advanced, not cloned).
  const all = await fittingRoomQueue.list();
  assert.strictEqual(all.length, baseline + 1, 'exactly one ticket beyond baseline exists');

  // Advanced via LEGAL transitions only (Picking Items -> Waiting for Room -> Ready).
  const historyStates = ticket.history.map((h) => h.state);
  assert.deepStrictEqual(historyStates, [
    STATES.REQUESTED,
    STATES.CONFIRMED,
    STATES.PICKING_ITEMS,
    STATES.WAITING_FOR_ROOM,
    STATES.READY,
  ]);
});

test('an already-Ready-or-beyond linked ticket is left unchanged (no illegal transition, no throw)', async () => {
  const { staffTasks, fittingRoomQueue, firestore } = buildWithQueue();
  const taskId = await toPreparing(staffTasks);

  // Drive a ticket all the way to In Fitting Room (past Ready).
  const created = await fittingRoomQueue.requestQueue({ userId: 'anon-1', items: [] });
  const id = created.ticket.id;
  await fittingRoomQueue.confirm(id);
  await fittingRoomQueue.advance(id, STATES.PICKING_ITEMS);
  await fittingRoomQueue.advance(id, STATES.WAITING_FOR_ROOM);
  await fittingRoomQueue.advance(id, STATES.READY);
  await fittingRoomQueue.advance(id, STATES.IN_FITTING_ROOM);

  const task = await firestore.get(STAFF_COLLECTION, taskId);
  task.queueTicketId = id;
  await firestore.set(STAFF_COLLECTION, taskId, task);

  const ready = await staffTasks.prepare(taskId, { fittingRoomId: 'fr-l2-01' });
  assert.strictEqual(ready.status, TASK_STATES.READY_FOR_COLLECTION);

  const ticket = await fittingRoomQueue.get(id);
  assert.strictEqual(ticket.status, STATES.IN_FITTING_ROOM, 'left untouched - not resurrected');
});

test('idempotency: reaching Ready does not create a second ticket on repeat', async () => {
  const { staffTasks, fittingRoomQueue, firestore } = buildWithQueue();
  const taskId = await toPreparing(staffTasks);

  // Baseline count of pre-seeded queue tickets.
  const baseline = (await fittingRoomQueue.list()).length;

  const first = await staffTasks.prepare(taskId, { fittingRoomId: 'fr-l2-01' });
  const ticketId = first.queueTicketId;
  assert.ok(ticketId);

  // Simulate a repeat by moving the task back to Preparing and re-readying it;
  // the enqueue guard must stay idempotent (reuse the linked ticket).
  const task = await firestore.get(STAFF_COLLECTION, taskId);
  task.status = TASK_STATES.PREPARING;
  await firestore.set(STAFF_COLLECTION, taskId, task);

  const second = await staffTasks.prepare(taskId, { fittingRoomId: 'fr-l2-01' });
  assert.strictEqual(second.queueTicketId, ticketId, 'same ticket reused');

  // Only the one auto-created ticket exists beyond the pre-seeded baseline.
  const all = await fittingRoomQueue.list();
  assert.strictEqual(all.length, baseline + 1, 'no duplicate ticket created');
  const autoTicket = all.find((t) => t.id === ticketId);
  assert.ok(autoTicket, 'the auto-created ticket is present');
  assert.strictEqual(autoTicket.status, STATES.READY);
});

test('robustness: a branch without a queue still marks the task ReadyForCollection (no throw)', async () => {
  const { staffTasks } = buildWithQueue({
    store: { id: 'store-x', name: 'No Queue Branch', fittingRooms: [], queueEnabled: false },
  });
  const taskId = await toPreparing(staffTasks);

  const ready = await staffTasks.prepare(taskId, { fittingRoomId: 'fr-l2-01' });
  assert.strictEqual(ready.status, TASK_STATES.READY_FOR_COLLECTION);
  assert.ok(!ready.queueTicketId, 'no ticket when the branch has no queue');
  // A non-fatal note explains why no ticket was issued.
  const note = ready.history.map((h) => h.note).filter(Boolean).join(' ');
  assert.match(note, /queue not available/i);
});

test('robustness: a throwing queue adapter does not break marking the task ready', async () => {
  const { staffTasks } = (function buildThrowing() {
    const adapters = createAdapters(loadConfig({}));
    const catalogue = createCatalogue({ firestore: adapters.firestore });
    const storeNavigation = createStoreNavigation({ firestore: adapters.firestore, catalogue });
    const fittingRoomQueue = {
      STATES,
      async get() { return null; },
      async requestQueue() { throw new Error('queue backend down'); },
      async confirm() { throw new Error('queue backend down'); },
      async advance() { throw new Error('queue backend down'); },
      async list() { return []; },
    };
    let tn = 0;
    const staffTasks = createStaffTasks({
      firestore: adapters.firestore,
      catalogue,
      storeNavigation,
      fittingRoomQueue,
      store: STORE,
      idgen: () => `task-throw-${(++tn)}`,
    });
    return { staffTasks };
  }());

  const taskId = await toPreparing(staffTasks);
  const ready = await staffTasks.prepare(taskId, { fittingRoomId: 'fr-l2-01' });
  assert.strictEqual(ready.status, TASK_STATES.READY_FOR_COLLECTION);
  const note = ready.history.map((h) => h.note).filter(Boolean).join(' ');
  assert.match(note, /could not enqueue/i);
});
