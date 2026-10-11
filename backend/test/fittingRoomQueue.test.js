'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { loadConfig } = require('../src/config');
const { createAdapters } = require('../src/adapters');
const { createFittingRoomQueue, STATES } = require('../src/services/fittingRoomQueue');

const STORE = require('../data/store.json');

function build(storeOverride) {
  const adapters = createAdapters(loadConfig({}));
  let counter = 0;
  const queue = createFittingRoomQueue({
    firestore: adapters.firestore,
    store: storeOverride || STORE,
    now: () => new Date(2025, 0, 1, 0, 0, counter++).toISOString(),
    idgen: () => `tkt-test-${(++counter)}`,
  });
  return { queue };
}

async function newTicket(queue) {
  const res = await queue.requestQueue({ userId: 'anon-1', items: [{ sku: 'TOP-OXF-004', size: 'M', colour: 'blue' }] });
  assert.strictEqual(res.supported, true);
  return res.ticket;
}

test('requestQueue checks branch support first - unsupported branch issues NO ticket', async () => {
  const { queue } = build({ id: 'store-x', name: 'No Queue Branch', fittingRooms: [], queueEnabled: false });
  const res = await queue.requestQueue({ userId: 'anon-1', items: [] });
  assert.strictEqual(res.supported, false);
  assert.strictEqual(res.ticket, null);
  assert.match(res.reason, /does_not_support/);
});

test('new ticket starts as Requested and is NEVER Confirmed before the store confirm() call', async () => {
  const { queue } = build();
  const ticket = await newTicket(queue);
  assert.strictEqual(ticket.status, STATES.REQUESTED);
  assert.strictEqual(ticket.confirmed, false);

  // Attempting to advance straight to Confirmed must be rejected.
  await assert.rejects(
    () => queue.advance(ticket.id, STATES.CONFIRMED),
    /only reach "Confirmed" via the store confirm/i
  );

  // Still not confirmed.
  const after = await queue.get(ticket.id);
  assert.strictEqual(after.status, STATES.REQUESTED);
  assert.strictEqual(after.confirmed, false);
});

test('full happy-path lifecycle advances through every state in exact order', async () => {
  const { queue } = build();
  const ticket = await newTicket(queue);

  const confirmed = await queue.confirm(ticket.id, { fittingRoomId: 'fr-l2-01' });
  assert.strictEqual(confirmed.status, STATES.CONFIRMED);
  assert.strictEqual(confirmed.confirmed, true);

  const order = [
    STATES.PICKING_ITEMS,
    STATES.WAITING_FOR_ROOM,
    STATES.READY,
    STATES.IN_FITTING_ROOM,
    STATES.COMPLETED,
  ];
  for (const target of order) {
    const updated = await queue.advance(ticket.id, target);
    assert.strictEqual(updated.status, target);
  }

  const final = await queue.get(ticket.id);
  const historyStates = final.history.map((h) => h.state);
  assert.deepStrictEqual(historyStates, [
    STATES.REQUESTED,
    STATES.CONFIRMED,
    STATES.PICKING_ITEMS,
    STATES.WAITING_FOR_ROOM,
    STATES.READY,
    STATES.IN_FITTING_ROOM,
    STATES.COMPLETED,
  ]);
});

test('EVERY illegal happy-path skip transition is rejected', async () => {
  const { queue } = build();

  // Requested -> Ready (skip) must be rejected.
  const t1 = await newTicket(queue);
  await assert.rejects(() => queue.advance(t1.id, STATES.READY), /illegal transition/i);

  // Requested -> Picking Items (skip Confirmed) rejected.
  const t2 = await newTicket(queue);
  await assert.rejects(() => queue.advance(t2.id, STATES.PICKING_ITEMS), /illegal transition/i);

  // Confirmed -> Waiting for Room (skip Picking Items) rejected.
  const t3 = await newTicket(queue);
  await queue.confirm(t3.id);
  await assert.rejects(() => queue.advance(t3.id, STATES.WAITING_FOR_ROOM), /illegal transition/i);

  // Confirmed -> Ready (skip) rejected.
  const t4 = await newTicket(queue);
  await queue.confirm(t4.id);
  await assert.rejects(() => queue.advance(t4.id, STATES.READY), /illegal transition/i);

  // Picking Items -> Ready (skip Waiting for Room) rejected.
  const t5 = await newTicket(queue);
  await queue.confirm(t5.id);
  await queue.advance(t5.id, STATES.PICKING_ITEMS);
  await assert.rejects(() => queue.advance(t5.id, STATES.IN_FITTING_ROOM), /illegal transition/i);

  // Waiting for Room -> In Fitting Room (skip Ready) rejected.
  const t6 = await newTicket(queue);
  await queue.confirm(t6.id);
  await queue.advance(t6.id, STATES.PICKING_ITEMS);
  await queue.advance(t6.id, STATES.WAITING_FOR_ROOM);
  await assert.rejects(() => queue.advance(t6.id, STATES.IN_FITTING_ROOM), /illegal transition/i);

  // Ready -> Completed (skip In Fitting Room) rejected.
  const t7 = await newTicket(queue);
  await queue.confirm(t7.id);
  await queue.advance(t7.id, STATES.PICKING_ITEMS);
  await queue.advance(t7.id, STATES.WAITING_FOR_ROOM);
  await queue.advance(t7.id, STATES.READY);
  await assert.rejects(() => queue.advance(t7.id, STATES.COMPLETED), /illegal transition/i);
});

test('confirm() is rejected unless the ticket is in Requested', async () => {
  const { queue } = build();
  const ticket = await newTicket(queue);
  await queue.confirm(ticket.id);
  // Confirming twice is illegal.
  await assert.rejects(() => queue.confirm(ticket.id), /cannot confirm/i);
});

test('exception state: UnavailableItems during picking, then re-pick is allowed', async () => {
  const { queue } = build();
  const ticket = await newTicket(queue);
  await queue.confirm(ticket.id);
  await queue.advance(ticket.id, STATES.PICKING_ITEMS);
  const unavailable = await queue.advance(ticket.id, STATES.UNAVAILABLE_ITEMS);
  assert.strictEqual(unavailable.status, STATES.UNAVAILABLE_ITEMS);
  // Re-pick with substitutes.
  const repick = await queue.advance(ticket.id, STATES.PICKING_ITEMS);
  assert.strictEqual(repick.status, STATES.PICKING_ITEMS);
});

test('exception state: DelayedPreparation during picking, then resume', async () => {
  const { queue } = build();
  const ticket = await newTicket(queue);
  await queue.confirm(ticket.id);
  await queue.advance(ticket.id, STATES.PICKING_ITEMS);
  const delayed = await queue.advance(ticket.id, STATES.DELAYED_PREPARATION);
  assert.strictEqual(delayed.status, STATES.DELAYED_PREPARATION);
  const resumed = await queue.advance(ticket.id, STATES.WAITING_FOR_ROOM);
  assert.strictEqual(resumed.status, STATES.WAITING_FOR_ROOM);
});

test('exception state: CustomerCancelled is allowed from a non-terminal state and is terminal', async () => {
  const { queue } = build();
  const ticket = await newTicket(queue);
  await queue.confirm(ticket.id);
  const cancelled = await queue.cancel(ticket.id);
  assert.strictEqual(cancelled.status, STATES.CUSTOMER_CANCELLED);
  // No further transitions out of a terminal state.
  await assert.rejects(() => queue.advance(ticket.id, STATES.PICKING_ITEMS), /terminal state/i);
});

test('exception state: NoShow only from Ready and is terminal', async () => {
  const { queue } = build();
  const ticket = await newTicket(queue);
  await queue.confirm(ticket.id);
  await queue.advance(ticket.id, STATES.PICKING_ITEMS);
  await queue.advance(ticket.id, STATES.WAITING_FOR_ROOM);
  await queue.advance(ticket.id, STATES.READY);
  const noShow = await queue.advance(ticket.id, STATES.NO_SHOW);
  assert.strictEqual(noShow.status, STATES.NO_SHOW);
  await assert.rejects(() => queue.advance(ticket.id, STATES.IN_FITTING_ROOM), /terminal state/i);

  // NoShow cannot be reached from Requested.
  const other = await newTicket(queue);
  await assert.rejects(() => queue.advance(other.id, STATES.NO_SHOW), /illegal transition/i);
});

test('exception state: ExpiredTicket from a non-terminal state is terminal', async () => {
  const { queue } = build();
  const ticket = await newTicket(queue);
  const expired = await queue.expire(ticket.id);
  assert.strictEqual(expired.status, STATES.EXPIRED_TICKET);
  await assert.rejects(() => queue.confirm(ticket.id), /cannot confirm/i);
  await assert.rejects(() => queue.advance(ticket.id, STATES.CONFIRMED), /only reach "Confirmed"/i);
});

test('advance rejects unknown target states and unknown tickets', async () => {
  const { queue } = build();
  const ticket = await newTicket(queue);
  await assert.rejects(() => queue.advance(ticket.id, 'Teleported'), /unknown target state/i);
  await assert.rejects(() => queue.advance('nope', STATES.PICKING_ITEMS), /not found/i);
});
