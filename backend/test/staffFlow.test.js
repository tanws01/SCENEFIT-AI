'use strict';

/**
 * Regression test for the end-to-end "Try this physically" picking flow.
 *
 * A customer taps "Try this physically" on a look -> POST /api/staff-task ->
 * staffTasks.submitTask() persists a picking request -> it must appear on the
 * Fitting Room Queue Staff tab's incoming picking requests board, which is fed
 * by analytics.staffDashboard().incomingPickingRequests -> staff then Accept /
 * Start preparing / Mark ready for collection, which auto-enqueues a
 * fitting-room queue ticket.
 *
 * This locks in that a task created at RUNTIME persists within the process and
 * merges with the seeded tasks (the firestore mock seeds ONCE into a closure
 * Map, so runtime writes survive subsequent queries). The test would FAIL if
 * the mock were ever changed to re-read the seed JSON on each query, because
 * the freshly created id would then disappear from the dashboard.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { loadConfig } = require('../src/config');
const { createAdapters } = require('../src/adapters');
const { createServices } = require('../src/server');

/** Build the exact service graph the running server uses. */
function build() {
  return createServices(createAdapters(loadConfig({})));
}

test('a customer-created picking task appears on the staff dashboard alongside the seeds, within one process', async () => {
  const { staffTasks, analytics } = build();

  // (1) Capture the staff board's incoming picking requests BEFORE.
  const before = await analytics.staffDashboard();
  const beforeIds = (before.incomingPickingRequests || []).map((t) => t.id);
  const beforeLen = beforeIds.length;
  assert.ok(beforeLen > 0, 'seed tasks are present on the staff board');
  assert.ok(beforeIds.includes('task-seed-0001'), 'a known seed task is present before');

  // (2) Customer taps "Try this physically" -> a picking request is created.
  const created = await staffTasks.submitTask({
    userId: 'demo-shopper-001',
    storeId: 'store-kl-01',
    garments: [{ sku: 'TOP-OXF-004', size: 'M', colour: 'white' }],
  });
  assert.ok(created.id, 'submitTask returns a task id');
  assert.strictEqual(created.status, 'Submitted');

  // (3) The staff board now shows length+1, includes the NEW id, and STILL
  //     includes the seed id (runtime write merged with the seed, not replaced).
  const after = await analytics.staffDashboard();
  const afterIds = (after.incomingPickingRequests || []).map((t) => t.id);
  assert.strictEqual(afterIds.length, beforeLen + 1, 'exactly one new request on the board');
  assert.ok(afterIds.includes(created.id), 'the newly created task appears on the staff board');
  assert.ok(afterIds.includes('task-seed-0001'), 'the seed task is still present (merge semantics preserved)');

  // (4) staffTasks.list() also includes the new task id.
  const listed = await staffTasks.list();
  assert.ok(listed.map((t) => t.id).includes(created.id), 'the new task is in staffTasks.list()');
});

test('staff drive the created task accept -> prepare -> prepare to ReadyForCollection and a linked queue ticket appears', async () => {
  const { staffTasks, analytics } = build();

  const created = await staffTasks.submitTask({
    userId: 'demo-shopper-001',
    garments: [{ sku: 'TOP-OXF-004', size: 'M', colour: 'white' }],
  });

  const accepted = await staffTasks.accept(created.id, { staffId: 'u-associate-001' });
  assert.strictEqual(accepted.status, 'Accepted');

  const preparing = await staffTasks.prepare(created.id);
  assert.strictEqual(preparing.status, 'Preparing');

  const ready = await staffTasks.prepare(created.id, { fittingRoomId: 'fr-l2-01' });
  assert.strictEqual(ready.status, 'ReadyForCollection');
  assert.ok(ready.queueTicketId, 'reaching ReadyForCollection auto-created a linked queue ticket');

  // The dashboard reflects the updated status and the auto-created queue ticket
  // backlinks to the source task.
  const dash = await analytics.staffDashboard();
  const onBoard = (dash.incomingPickingRequests || []).find((t) => t.id === created.id);
  assert.ok(onBoard, 'the task is still on the board after reaching ReadyForCollection');
  assert.strictEqual(onBoard.status, 'ReadyForCollection');

  const linkedTicket = (dash.queueTickets || []).find((t) => t.sourceTaskId === created.id);
  assert.ok(linkedTicket, 'an auto-enqueued fitting-room ticket backlinks to the task');
  assert.strictEqual(linkedTicket.status, 'Ready');
});
