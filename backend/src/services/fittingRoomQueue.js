'use strict';

/**
 * Smart fitting-room queue - F11.
 *
 * A STRICT state machine for fitting-room preparation + room allocation.
 *
 * Happy path (exact documented order):
 *   Requested -> Confirmed -> Picking Items -> Waiting for Room -> Ready
 *   -> In Fitting Room -> Completed
 *
 * Exception states / transitions:
 *   UnavailableItems, DelayedPreparation, CustomerCancelled, NoShow,
 *   ExpiredTicket
 *
 * HARD RULES (F11):
 *   - A ticket starts as "Requested" (customer asked). It MUST NOT reach
 *     "Confirmed" until the simulated retailer/store operational system calls
 *     confirm(). We never promise a confirmed slot before that.
 *   - requestQueue first checks whether the branch SUPPORTS fitting-room queue
 *     requests; if it does not, no ticket is issued.
 *   - advance(ticket, targetState) REJECTS every illegal transition.
 *
 * BOUNDARY PRINCIPLE: queue confirmation is a retail/operational fact owned by
 * the application + store system, never invented by Gemini.
 *
 * Persisted via the Firestore adapter.
 */

const COLLECTION = 'fittingRoomQueue';

/** Canonical state names. */
const STATES = Object.freeze({
  REQUESTED: 'Requested',
  CONFIRMED: 'Confirmed',
  PICKING_ITEMS: 'Picking Items',
  WAITING_FOR_ROOM: 'Waiting for Room',
  READY: 'Ready',
  IN_FITTING_ROOM: 'In Fitting Room',
  COMPLETED: 'Completed',
  // Exception states.
  UNAVAILABLE_ITEMS: 'UnavailableItems',
  DELAYED_PREPARATION: 'DelayedPreparation',
  CUSTOMER_CANCELLED: 'CustomerCancelled',
  NO_SHOW: 'NoShow',
  EXPIRED_TICKET: 'ExpiredTicket',
});

/** Terminal states - no transitions out. */
const TERMINAL_STATES = Object.freeze([
  STATES.COMPLETED,
  STATES.CUSTOMER_CANCELLED,
  STATES.NO_SHOW,
  STATES.EXPIRED_TICKET,
]);

/**
 * Allowed transitions map: fromState -> set of allowed target states.
 *
 * The happy-path chain is strictly linear. Exception transitions are allowed
 * from the realistic points where they can occur:
 *   - CustomerCancelled: any non-terminal state (customer stays in control).
 *   - ExpiredTicket: any non-terminal state (ticket TTL lapses).
 *   - UnavailableItems / DelayedPreparation: only while items are being picked.
 *   - NoShow: only when the room is Ready and the customer never arrives.
 */
const TRANSITIONS = Object.freeze({
  [STATES.REQUESTED]: Object.freeze([
    STATES.CONFIRMED,
    STATES.CUSTOMER_CANCELLED,
    STATES.EXPIRED_TICKET,
  ]),
  [STATES.CONFIRMED]: Object.freeze([
    STATES.PICKING_ITEMS,
    STATES.CUSTOMER_CANCELLED,
    STATES.EXPIRED_TICKET,
  ]),
  [STATES.PICKING_ITEMS]: Object.freeze([
    STATES.WAITING_FOR_ROOM,
    STATES.UNAVAILABLE_ITEMS,
    STATES.DELAYED_PREPARATION,
    STATES.CUSTOMER_CANCELLED,
    STATES.EXPIRED_TICKET,
  ]),
  [STATES.DELAYED_PREPARATION]: Object.freeze([
    STATES.PICKING_ITEMS,
    STATES.WAITING_FOR_ROOM,
    STATES.UNAVAILABLE_ITEMS,
    STATES.CUSTOMER_CANCELLED,
    STATES.EXPIRED_TICKET,
  ]),
  [STATES.WAITING_FOR_ROOM]: Object.freeze([
    STATES.READY,
    STATES.CUSTOMER_CANCELLED,
    STATES.EXPIRED_TICKET,
  ]),
  [STATES.READY]: Object.freeze([
    STATES.IN_FITTING_ROOM,
    STATES.NO_SHOW,
    STATES.CUSTOMER_CANCELLED,
    STATES.EXPIRED_TICKET,
  ]),
  [STATES.IN_FITTING_ROOM]: Object.freeze([
    STATES.COMPLETED,
    STATES.CUSTOMER_CANCELLED,
  ]),
  // Exception + terminal states.
  [STATES.UNAVAILABLE_ITEMS]: Object.freeze([
    STATES.PICKING_ITEMS, // re-pick with substitutes
    STATES.CUSTOMER_CANCELLED,
    STATES.EXPIRED_TICKET,
  ]),
  [STATES.COMPLETED]: Object.freeze([]),
  [STATES.CUSTOMER_CANCELLED]: Object.freeze([]),
  [STATES.NO_SHOW]: Object.freeze([]),
  [STATES.EXPIRED_TICKET]: Object.freeze([]),
});

/** Is this a legal transition? */
function canTransition(fromState, toState) {
  const allowed = TRANSITIONS[fromState];
  return Array.isArray(allowed) && allowed.includes(toState);
}

/**
 * @param {object} deps
 * @param {object} deps.firestore firestore adapter
 * @param {object} [deps.store] seeded store/branch info (for queue-support check)
 * @param {() => string} [deps.now] clock injection for deterministic tests
 * @param {() => string} [deps.idgen] id generator injection
 */
function createFittingRoomQueue(deps = {}) {
  const firestore = deps.firestore;
  if (!firestore) throw new Error('fittingRoomQueue requires a firestore adapter');
  const defaultBranch = deps.store || null;
  const now = typeof deps.now === 'function' ? deps.now : () => new Date().toISOString();
  let seq = 0;
  const idgen = typeof deps.idgen === 'function'
    ? deps.idgen
    : () => `tkt-${Date.now()}-${(++seq).toString().padStart(4, '0')}`;

  /**
   * Does a branch support fitting-room queue requests? We treat a branch as
   * queue-capable when its store record declares fitting rooms (or an explicit
   * queueEnabled flag). This is a deterministic retailer-operational fact.
   * @param {object} branch store record
   */
  function branchSupportsQueue(branch) {
    if (!branch || typeof branch !== 'object') return false;
    if (branch.queueEnabled === false) return false;
    if (branch.queueEnabled === true) return true;
    return Array.isArray(branch.fittingRooms) && branch.fittingRooms.length > 0;
  }

  async function load(ticketId) {
    const stored = await firestore.get(COLLECTION, ticketId);
    return stored || null;
  }

  async function save(ticket) {
    await firestore.set(COLLECTION, ticket.id, ticket);
    return ticket;
  }

  function pushHistory(ticket, state, note) {
    ticket.history = Array.isArray(ticket.history) ? ticket.history : [];
    ticket.history.push({ state, at: now(), note: note || null });
    ticket.status = state;
    ticket.updatedAt = now();
    return ticket;
  }

  /**
   * Customer requests garment preparation + a fitting-room place.
   *
   * First checks the branch supports queue requests. If it does, issues a
   * ticket in the "Requested" state (NOT confirmed). The ticket carries a live
   * status the customer can poll while they keep browsing.
   *
   * @param {object} input
   * @param {object} input.branch store/branch record (seeded, deterministic)
   * @param {string} [input.userId]
   * @param {Array<{sku,size,colour}>} [input.items] garments to prepare
   * @returns {Promise<object>} { supported, ticket? , reason? }
   */
  async function requestQueue(input = {}) {
    const branch = input.branch || defaultBranch || null;
    if (!branchSupportsQueue(branch)) {
      return {
        supported: false,
        ticket: null,
        reason: 'branch_does_not_support_fitting_room_queue',
        message:
          'This branch does not currently support fitting-room queue requests. '
          + 'Please ask a store associate for help trying items in store.',
      };
    }

    const id = idgen();
    const ticket = {
      id,
      storeId: branch.id || branch.storeId || null,
      storeName: branch.shortName || branch.name || null,
      userId: input.userId || null,
      items: Array.isArray(input.items) ? input.items.map((i) => ({
        sku: i.sku || null,
        size: i.size || null,
        colour: i.colour || null,
      })) : [],
      status: STATES.REQUESTED,
      confirmed: false,
      fittingRoomId: null,
      issuedAt: now(),
      updatedAt: now(),
      history: [],
      // Customer control affordances.
      liveStatusMessage: 'Request received. Waiting for the store to confirm your fitting-room place.',
    };
    pushHistory(ticket, STATES.REQUESTED, 'Customer requested fitting-room preparation.');
    await save(ticket);
    return { supported: true, ticket };
  }

  /**
   * The simulated store/operational system confirms acceptance. ONLY after
   * this does the ticket become "Confirmed". We never promise a confirmed slot
   * before this call.
   *
   * @param {string} ticketId
   * @param {object} [opts] { fittingRoomId }
   */
  async function confirm(ticketId, opts = {}) {
    const ticket = await load(ticketId);
    if (!ticket) throw queueError('NOT_FOUND', `ticket ${ticketId} not found`);
    if (ticket.status !== STATES.REQUESTED) {
      throw queueError(
        'ILLEGAL_TRANSITION',
        `cannot confirm a ticket in state "${ticket.status}"`
      );
    }
    ticket.confirmed = true;
    ticket.fittingRoomId = opts.fittingRoomId || ticket.fittingRoomId || null;
    ticket.liveStatusMessage = 'The store confirmed your fitting-room place. Preparing your items.';
    pushHistory(ticket, STATES.CONFIRMED, 'Store operational system confirmed the request.');
    return save(ticket);
  }

  /**
   * Advance a ticket to a target state, REJECTING any illegal transition.
   *
   * @param {string} ticketId
   * @param {string} targetState one of STATES values
   * @param {object} [opts] { fittingRoomId, note }
   * @returns {Promise<object>} updated ticket
   */
  async function advance(ticketId, targetState, opts = {}) {
    const ticket = await load(ticketId);
    if (!ticket) throw queueError('NOT_FOUND', `ticket ${ticketId} not found`);

    if (!Object.values(STATES).includes(targetState)) {
      throw queueError('UNKNOWN_STATE', `unknown target state "${targetState}"`);
    }

    // Guard: moving to Confirmed is only ever done via confirm() (store system).
    if (targetState === STATES.CONFIRMED) {
      throw queueError(
        'ILLEGAL_TRANSITION',
        'a ticket can only reach "Confirmed" via the store confirm() call'
      );
    }

    if (TERMINAL_STATES.includes(ticket.status)) {
      throw queueError(
        'ILLEGAL_TRANSITION',
        `ticket is in terminal state "${ticket.status}" and cannot advance`
      );
    }

    if (!canTransition(ticket.status, targetState)) {
      throw queueError(
        'ILLEGAL_TRANSITION',
        `illegal transition from "${ticket.status}" to "${targetState}"`
      );
    }

    if (opts.fittingRoomId) ticket.fittingRoomId = opts.fittingRoomId;
    ticket.liveStatusMessage = liveMessageFor(targetState, ticket);
    pushHistory(ticket, targetState, opts.note || null);
    return save(ticket);
  }

  /**
   * Customer cancels (stays in control). Allowed from any non-terminal state.
   * @param {string} ticketId
   */
  async function cancel(ticketId, opts = {}) {
    return advance(ticketId, STATES.CUSTOMER_CANCELLED, { note: opts.note || 'Customer cancelled.' });
  }

  /**
   * Ticket TTL lapses (expired). Allowed from any non-terminal state.
   * @param {string} ticketId
   */
  async function expire(ticketId, opts = {}) {
    return advance(ticketId, STATES.EXPIRED_TICKET, { note: opts.note || 'Ticket expired.' });
  }

  /** Fetch a ticket's current state + live status. */
  async function get(ticketId) {
    return load(ticketId);
  }

  /** List queue tickets (for the staff operations dashboard). */
  async function list(predicate) {
    return firestore.query(COLLECTION, predicate);
  }

  return {
    requestQueue,
    confirm,
    advance,
    cancel,
    expire,
    get,
    list,
    branchSupportsQueue,
    canTransition,
    STATES,
    TRANSITIONS,
    TERMINAL_STATES,
  };
}

/** Human-friendly live status per state. */
function liveMessageFor(state, ticket) {
  switch (state) {
    case STATES.PICKING_ITEMS:
      return 'A store associate is picking your items.';
    case STATES.WAITING_FOR_ROOM:
      return 'Your items are ready. Waiting for a fitting room to free up.';
    case STATES.READY:
      return `Your fitting room ${ticket.fittingRoomId || ''} is ready. Please head over.`.trim();
    case STATES.IN_FITTING_ROOM:
      return 'Enjoy trying on your items in the fitting room.';
    case STATES.COMPLETED:
      return 'Fitting-room session completed. Thank you.';
    case STATES.UNAVAILABLE_ITEMS:
      return 'Some items are unavailable. We can offer substitutes or you may cancel.';
    case STATES.DELAYED_PREPARATION:
      return 'Preparation is taking a little longer than expected. Thanks for your patience.';
    case STATES.CUSTOMER_CANCELLED:
      return 'Your request has been cancelled.';
    case STATES.NO_SHOW:
      return 'The fitting-room place was released after no arrival.';
    case STATES.EXPIRED_TICKET:
      return 'This queue ticket has expired.';
    default:
      return 'Status updated.';
  }
}

function queueError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

module.exports = {
  createFittingRoomQueue,
  STATES,
  TRANSITIONS,
  TERMINAL_STATES,
  COLLECTION,
};
