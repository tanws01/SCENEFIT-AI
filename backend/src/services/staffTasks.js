'use strict';

/**
 * Staff-assisted product collection - F10.
 *
 * A customer selects one or more garments; the system submits each garment's
 * SKU, size, colour, and mapped rack location to store staff as a PICKING
 * TASK. Staff accept or reject the task based on availability; the task status
 * propagates back to the customer. On acceptance, staff prepare the garments
 * for fitting-room collection.
 *
 * HARD RULE: availability / SKU validity are retail facts resolved by the
 * deterministic catalogue + storeNavigation services, never invented by AI.
 *
 * Persisted via the Firestore adapter.
 */

const COLLECTION = 'staffTasks';
// The fitting-room queue persists tickets under this collection. We reuse the
// shared firestore adapter to persist the task<->ticket correlation backlink
// (sourceTaskId) that the queue state machine itself does not own.
const { COLLECTION: QUEUE_COLLECTION } = require('./fittingRoomQueue');

/** Picking-task lifecycle states. */
const TASK_STATES = Object.freeze({
  SUBMITTED: 'Submitted',
  ACCEPTED: 'Accepted',
  REJECTED: 'Rejected',
  PREPARING: 'Preparing',
  READY_FOR_COLLECTION: 'ReadyForCollection',
  COMPLETED: 'Completed',
});

/**
 * @param {object} deps
 * @param {object} deps.firestore firestore adapter
 * @param {object} [deps.catalogue] catalogue service (resolve name / availability)
 * @param {object} [deps.storeNavigation] navigation service (map rack location)
 * @param {object} [deps.fittingRoomQueue] fitting-room queue service (F11). OPTIONAL -
 *   when wired, reaching ReadyForCollection auto-enqueues (or advances) a queue
 *   ticket to 'Ready' via the LEGAL state-machine path so the ready task is
 *   reflected on the fitting-room queue.
 * @param {object} [deps.store] seeded store/branch record (passed to the queue
 *   service when creating a ticket; only used when fittingRoomQueue is wired).
 * @param {() => string} [deps.now]
 * @param {() => string} [deps.idgen]
 */
function createStaffTasks(deps = {}) {
  const firestore = deps.firestore;
  if (!firestore) throw new Error('staffTasks requires a firestore adapter');
  const catalogue = deps.catalogue || null;
  const storeNavigation = deps.storeNavigation || null;
  const fittingRoomQueue = deps.fittingRoomQueue || null;
  const store = deps.store || null;
  const now = typeof deps.now === 'function' ? deps.now : () => new Date().toISOString();
  let seq = 0;
  const idgen = typeof deps.idgen === 'function'
    ? deps.idgen
    : () => `task-${Date.now()}-${(++seq).toString().padStart(4, '0')}`;

  async function load(taskId) {
    return (await firestore.get(COLLECTION, taskId)) || null;
  }

  async function save(task) {
    await firestore.set(COLLECTION, task.id, task);
    return task;
  }

  function pushHistory(task, state, note) {
    task.history = Array.isArray(task.history) ? task.history : [];
    task.history.push({ state, at: now(), note: note || null });
    task.status = state;
    task.updatedAt = now();
    return task;
  }

  /**
   * Enrich a requested garment with retail-truth facts: resolved name, whether
   * the requested size is in stock, and mapped rack location.
   * @param {{sku,size,colour}} garment
   */
  async function enrichGarment(garment = {}) {
    const sku = garment.sku || null;
    const size = garment.size || null;
    const colour = garment.colour || null;

    let name = null;
    let available = null; // null = unknown (no catalogue wired)
    if (catalogue && sku) {
      const product = await catalogue.getProduct(sku);
      name = product ? product.name : null;
      if (product) {
        available = size != null
          ? (await catalogue.getStock(sku, size)) > 0
          : await catalogue.isInStock(sku);
      } else {
        available = false; // unknown SKU is never fabricated as available
      }
    }

    let location = null;
    if (storeNavigation && sku) {
      const nav = await storeNavigation.locate(sku);
      location = nav.found
        ? nav.location
        : { available: false, staffAssistance: true };
    }

    return { sku, size, colour, name, available, location };
  }

  /**
   * Submit a picking task for one or more garments.
   * @param {object} input
   * @param {string} [input.userId]
   * @param {string} [input.storeId]
   * @param {Array<{sku,size,colour}>} input.garments
   */
  async function submitTask(input = {}) {
    const garments = Array.isArray(input.garments) ? input.garments : [];
    const enriched = [];
    for (const g of garments) enriched.push(await enrichGarment(g));

    const task = {
      id: idgen(),
      type: 'pull_items',
      userId: input.userId || null,
      storeId: input.storeId || null,
      garments: enriched,
      status: TASK_STATES.SUBMITTED,
      assignedTo: null,
      rejectionReason: null,
      customerStatus: 'Your request has been sent to a store associate.',
      createdAt: now(),
      updatedAt: now(),
      history: [],
    };
    pushHistory(task, TASK_STATES.SUBMITTED, 'Customer submitted picking request.');
    return save(task);
  }

  /** Staff accepts the task (and is assigned to it). */
  async function accept(taskId, opts = {}) {
    const task = await load(taskId);
    if (!task) throw taskError('NOT_FOUND', `task ${taskId} not found`);
    if (task.status !== TASK_STATES.SUBMITTED) {
      throw taskError('ILLEGAL_TRANSITION', `cannot accept a task in state "${task.status}"`);
    }
    task.assignedTo = opts.staffId || opts.assignedTo || 'staff-unassigned';
    task.customerStatus = 'A store associate accepted your request and will prepare your items.';
    pushHistory(task, TASK_STATES.ACCEPTED, `Accepted by ${task.assignedTo}.`);
    return save(task);
  }

  /** Staff rejects the task (e.g. items unavailable). */
  async function reject(taskId, opts = {}) {
    const task = await load(taskId);
    if (!task) throw taskError('NOT_FOUND', `task ${taskId} not found`);
    if (task.status !== TASK_STATES.SUBMITTED) {
      throw taskError('ILLEGAL_TRANSITION', `cannot reject a task in state "${task.status}"`);
    }
    task.rejectionReason = opts.reason || 'items_unavailable';
    task.customerStatus =
      'Unfortunately the store could not fulfil this request ('
      + task.rejectionReason + '). Please try alternatives or ask an associate.';
    pushHistory(task, TASK_STATES.REJECTED, `Rejected: ${task.rejectionReason}.`);
    return save(task);
  }

  /**
   * Staff prepares garments for fitting-room collection. Can move from Accepted
   * (-> Preparing) and from Preparing (-> ReadyForCollection).
   */
  async function prepare(taskId, opts = {}) {
    const task = await load(taskId);
    if (!task) throw taskError('NOT_FOUND', `task ${taskId} not found`);

    if (task.status === TASK_STATES.ACCEPTED) {
      task.customerStatus = 'A store associate is preparing your items.';
      pushHistory(task, TASK_STATES.PREPARING, opts.note || 'Preparation started.');
      return save(task);
    }
    if (task.status === TASK_STATES.PREPARING) {
      task.fittingRoomId = opts.fittingRoomId || task.fittingRoomId || null;
      task.customerStatus =
        'Your items are ready for collection'
        + (task.fittingRoomId ? ` at fitting room ${task.fittingRoomId}.` : '.');
      pushHistory(task, TASK_STATES.READY_FOR_COLLECTION, opts.note || 'Items prepared for fitting room.');
      // A ready-for-collection task must be reflected on the fitting-room
      // queue. Create or advance a linked ticket to 'Ready' via the LEGAL
      // state-machine path. This NEVER breaks marking the task ready: any
      // queue failure is caught and recorded as a non-fatal note.
      await ensureReadyQueueTicket(task);
      return save(task);
    }
    throw taskError('ILLEGAL_TRANSITION', `cannot prepare a task in state "${task.status}"`);
  }

  /**
   * Ensure the fitting-room queue reflects a task that just became
   * ReadyForCollection: a ticket linked to the task is driven to the 'Ready'
   * state WITHOUT any illegal state-machine jump.
   *
   * Behaviour (all guarded so prepare() stays robust):
   *   - No queue service wired: no-op.
   *   - Already-linked ticket (task.queueTicketId): advance THAT ticket legally
   *     up to 'Ready' from wherever it currently is; if it is already at/after
   *     'Ready' leave it; if it is terminal/exception do not resurrect it.
   *     Idempotent - never creates a duplicate.
   *   - No linked ticket: create one (requestQueue), confirm() it (the store
   *     operational system is confirming because staff just prepared it), then
   *     advance Picking Items -> Waiting for Room -> Ready.
   *   - Branch does not support the queue / requestQueue returns supported:false
   *     / anything throws: do NOT fail; record a non-fatal note and continue.
   *
   * @param {object} task the task mutated in place (persisted by the caller)
   */
  async function ensureReadyQueueTicket(task) {
    if (!fittingRoomQueue) return;
    try {
      let ticket = null;
      if (task.queueTicketId) {
        // Idempotency guard: a ticket is already linked. Advance it, never
        // create a duplicate.
        ticket = await fittingRoomQueue.get(task.queueTicketId);
        if (!ticket) {
          // The linked ticket vanished; fall through to create a fresh one.
          task.queueTicketId = null;
        }
      }

      if (!ticket) {
        const result = await fittingRoomQueue.requestQueue({
          branch: store,
          userId: task.userId,
          items: (task.garments || []).map((g) => ({
            sku: g.sku, size: g.size, colour: g.colour,
          })),
        });
        if (!result || result.supported === false || !result.ticket) {
          pushHistory(
            task,
            TASK_STATES.READY_FOR_COLLECTION,
            'Fitting-room queue not available at this branch; task is ready for collection without a queue ticket.'
          );
          return;
        }
        ticket = result.ticket;
        task.queueTicketId = ticket.id;
        // Symmetric backlink so the dashboard/analytics can correlate them.
        await linkTicketToTask(ticket, task);
      } else if (!task.queueTicketId) {
        task.queueTicketId = ticket.id;
      }

      await driveTicketToReady(ticket, task);
    } catch (err) {
      // A queue error must NOT break marking the task ready.
      pushHistory(
        task,
        TASK_STATES.READY_FOR_COLLECTION,
        `Could not enqueue fitting-room ticket (${err.message}); task is still ready for collection.`
      );
    }
  }

  /**
   * Store the task backlink + fittingRoomId on the ticket. We do this through
   * the queue's own transition calls where possible, but the sourceTaskId is a
   * correlation field the queue state machine does not own, so we persist it
   * directly via the shared firestore adapter under the queue collection.
   * @param {object} ticket
   * @param {object} task
   */
  async function linkTicketToTask(ticket, task) {
    ticket.sourceTaskId = task.id;
    if (task.fittingRoomId) ticket.fittingRoomId = task.fittingRoomId;
    await firestore.set(QUEUE_COLLECTION, ticket.id, ticket);
  }

  /**
   * Walk the legal queue state chain from the ticket's CURRENT state up to
   * 'Ready', skipping steps already passed and never forcing an illegal jump.
   * Legal path: Requested ->(confirm)-> Confirmed ->(advance)-> Picking Items
   * ->(advance)-> Waiting for Room ->(advance)-> Ready. If the ticket is already
   * at/after Ready, or in a terminal/exception state, leave it untouched.
   * @param {object} ticket current ticket (will be re-read as it transitions)
   * @param {object} task
   */
  async function driveTicketToReady(ticket, task) {
    const S = fittingRoomQueue.STATES;
    const fittingRoomId = task.fittingRoomId || ticket.fittingRoomId || null;

    // The ONLY states we legally advance FROM, in order, toward Ready.
    const forwardable = [S.REQUESTED, S.CONFIRMED, S.PICKING_ITEMS, S.WAITING_FOR_ROOM];
    // Safety bound: the forward chain has at most 4 hops.
    for (let guard = 0; guard < 6; guard += 1) {
      const current = await fittingRoomQueue.get(ticket.id);
      if (!current) return;
      const state = current.status;
      if (state === S.READY) {
        // Make sure the correlation backlink + room are persisted.
        if (current.sourceTaskId !== task.id || (fittingRoomId && current.fittingRoomId !== fittingRoomId)) {
          await linkTicketToTask(current, task);
        }
        return;
      }
      // Already past Ready (In Fitting Room / Completed) or in a terminal /
      // exception state: do not resurrect or advance it.
      if (!forwardable.includes(state)) return;

      if (state === S.REQUESTED) {
        await fittingRoomQueue.confirm(ticket.id, { fittingRoomId });
      } else if (state === S.CONFIRMED) {
        await fittingRoomQueue.advance(ticket.id, S.PICKING_ITEMS, {
          fittingRoomId, note: `Auto-picking for staff task ${task.id}.`,
        });
      } else if (state === S.PICKING_ITEMS) {
        await fittingRoomQueue.advance(ticket.id, S.WAITING_FOR_ROOM, {
          fittingRoomId, note: `Items prepared for staff task ${task.id}.`,
        });
      } else if (state === S.WAITING_FOR_ROOM) {
        await fittingRoomQueue.advance(ticket.id, S.READY, {
          fittingRoomId, note: `Ready for collection for staff task ${task.id}.`,
        });
      }
    }
    // Persist the backlink after reaching Ready.
    const finalTicket = await fittingRoomQueue.get(ticket.id);
    if (finalTicket && finalTicket.sourceTaskId !== task.id) {
      await linkTicketToTask(finalTicket, task);
    }
  }

  /** Mark the collection completed. */
  async function complete(taskId, opts = {}) {
    const task = await load(taskId);
    if (!task) throw taskError('NOT_FOUND', `task ${taskId} not found`);
    if (task.status !== TASK_STATES.READY_FOR_COLLECTION) {
      throw taskError('ILLEGAL_TRANSITION', `cannot complete a task in state "${task.status}"`);
    }
    task.customerStatus = 'Collection completed. Enjoy your fitting-room session.';
    pushHistory(task, TASK_STATES.COMPLETED, opts.note || 'Collection completed.');
    return save(task);
  }

  async function get(taskId) {
    return load(taskId);
  }

  /** List tasks (for the staff operations dashboard). */
  async function list(predicate) {
    return firestore.query(COLLECTION, predicate);
  }

  return {
    submitTask,
    accept,
    reject,
    prepare,
    complete,
    get,
    list,
    enrichGarment,
    TASK_STATES,
  };
}

function taskError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

module.exports = { createStaffTasks, TASK_STATES, COLLECTION };
