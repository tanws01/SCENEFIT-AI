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
 * @param {() => string} [deps.now]
 * @param {() => string} [deps.idgen]
 */
function createStaffTasks(deps = {}) {
  const firestore = deps.firestore;
  if (!firestore) throw new Error('staffTasks requires a firestore adapter');
  const catalogue = deps.catalogue || null;
  const storeNavigation = deps.storeNavigation || null;
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
      return save(task);
    }
    throw taskError('ILLEGAL_TRANSITION', `cannot prepare a task in state "${task.status}"`);
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
