'use strict';

/**
 * SCENEFIT AI - Staff Operations Dashboard (F14).
 *
 * Consumes /api/dashboard/staff plus the staff-task and fitting-room queue
 * endpoints (all gated by Firebase Auth role). Staff can:
 *   - see incoming picking requests with SKU / size / colour / rack location,
 *   - accept/assign and update prep status (Preparing -> ReadyForCollection),
 *   - view fitting-room availability,
 *   - manage queue tickets: confirm, advance through the lifecycle, notify
 *     readiness, record completion / cancellation / exceptions.
 */

(function () {
  const Api = window.ScenefitApi;

  const $ = (s) => document.querySelector(s);
  const el = (tag, attrs, children) => {
    const n = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (v != null) n.setAttribute(k, v);
    }
    for (const c of [].concat(children || [])) {
      if (c == null) continue;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return n;
  };
  const setStatus = (m, err) => { const s = $('#status'); s.textContent = m || ''; s.className = err ? 'error-box' : 'spinner'; };
  const token = () => $('#token').value.trim();

  // Queue lifecycle targets staff can push a ticket toward (confirm is separate).
  const ADVANCE_TARGETS = ['Picking Items', 'Waiting for Room', 'Ready', 'In Fitting Room', 'Completed'];
  const EXCEPTION_TARGETS = ['UnavailableItems', 'DelayedPreparation', 'NoShow', 'ExpiredTicket'];

  async function load() {
    setStatus('Loading staff operations...');
    try {
      const data = await Api.staffDashboard();
      $('#authStatus').textContent = '';
      renderStaffKpis(data);
      renderPicking(data.incomingPickingRequests || []);
      renderFittingRooms(data.fittingRoomAvailability || []);
      renderQueueOverview(data.queueTickets || []);
      setStatus('');
    } catch (e) {
      setStatus('', false);
      $('#authStatus').textContent = `Failed to load: ${e.message}`;
    }
  }

  // Operational KPI tiles across the staff board (deterministic counts).
  function renderStaffKpis(data) {
    const root = $('#staffKpis');
    if (!root) return;
    root.innerHTML = '';
    const summary = data.operationsSummary || {};
    const tiles = [
      { label: 'Open picking tasks', value: summary.openTasks },
      { label: 'Ready for collection', value: summary.readyForCollection },
      { label: 'Fitting rooms free', value: summary.fittingRoomsAvailable },
      { label: 'Fitting rooms total', value: summary.fittingRoomsTotal },
      { label: 'Queue tickets waiting', value: summary.queueWaiting },
    ].filter((t) => t.value != null);
    if (!tiles.length) return;
    const grid = el('div', { class: 'kpi-grid' });
    tiles.forEach((t) => grid.appendChild(el('div', { class: 'kpi-tile' }, [
      el('div', { class: 'kpi-value' }, String(t.value)),
      el('div', { class: 'kpi-label' }, t.label),
    ])));
    root.appendChild(el('div', { class: 'panel' }, [el('h3', null, 'Operations at a glance'), grid]));
  }

  function renderPicking(tasks) {
    const root = $('#picking');
    root.innerHTML = '';
    const panel = el('div', { class: 'panel' }, [el('h3', null, `Incoming picking requests (${tasks.length})`)]);
    if (!tasks.length) panel.appendChild(el('p', { class: 'muted' }, 'No picking requests yet. Create a demo request above.'));
    tasks.forEach((t) => panel.appendChild(renderTaskCard(t)));
    root.appendChild(panel);
  }

  function renderTaskCard(t) {
    const card = el('div', { class: 'alt-card' });
    card.appendChild(el('p', null, [el('strong', null, `Task ${t.id}`), document.createTextNode(` \u00b7 ${t.status}`)]));
    if (t.assignedTo) card.appendChild(el('p', { class: 'muted' }, `Assigned: ${t.assignedTo}`));
    const list = el('ul', { class: 'item-list' }, (t.garments || []).map((g) => {
      const loc = g.location && g.location.rack
        ? `${g.location.zone || ''} ${g.location.aisle || ''} ${g.location.rack || ''}`.trim()
        : 'staff assistance';
      return el('li', null, [
        el('span', null, `${g.sku} \u00b7 size ${g.size || '-'} \u00b7 ${g.colour || '-'}`),
        el('span', { class: 'meta' }, loc),
      ]);
    }));
    card.appendChild(list);

    const actions = el('div', { class: 'actions' });
    const result = el('p', { class: 'muted' });
    const act = async (fn) => {
      try { const r = await fn(); result.textContent = `Status: ${r.status} \u00b7 ${r.customerStatus || ''}`; await load(); }
      catch (e) { result.textContent = `Action failed: ${e.message}`; }
    };
    if (t.status === 'Submitted') {
      actions.appendChild(el('button', { class: 'btn small', type: 'button', onclick: () => act(() => taskAction(t.id, 'accept')) }, 'Accept / assign'));
      actions.appendChild(el('button', { class: 'btn small ghost', type: 'button', onclick: () => act(() => taskAction(t.id, 'reject')) }, 'Reject'));
    }
    if (t.status === 'Accepted' || t.status === 'Preparing') {
      actions.appendChild(el('button', { class: 'btn small', type: 'button', onclick: () => act(() => taskAction(t.id, 'prepare')) },
        t.status === 'Accepted' ? 'Start preparing' : 'Mark ready for collection'));
    }
    card.appendChild(actions);
    card.appendChild(result);
    return card;
  }

  function taskAction(id, action) {
    const path = `/api/staff-task/${encodeURIComponent(id)}/${action}`;
    return rawPost(path, {});
  }

  // Direct POST helper with the staff auth header (actions not in api.js).
  async function rawPost(path, body) {
    const res = await fetch((Api.base || '') + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': token() },
      body: JSON.stringify(body || {}),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) { const err = new Error(data.detail || data.error || `HTTP ${res.status}`); err.status = res.status; throw err; }
    return data;
  }

  function renderFittingRooms(rooms) {
    const root = $('#fittingRooms');
    root.innerHTML = '';
    const panel = el('div', { class: 'panel' }, [
      el('h3', null, 'Fitting-room availability'),
      el('table', { class: 'data' }, [
        el('tr', null, [el('th', null, 'Room'), el('th', null, 'Zone'), el('th', null, 'Level'), el('th', null, 'Capacity'), el('th', null, 'Status')]),
      ].concat(rooms.map((r) => el('tr', null, [
        el('td', null, r.id),
        el('td', null, String(r.zone || '-')),
        el('td', null, String(r.level || '-')),
        el('td', null, String(r.capacity || 1)),
        el('td', null, [el('span', { class: `pill ${r.status === 'Available' ? 'ok' : 'busy'}` }, String(r.status || '-'))]),
      ])))),
    ]);
    root.appendChild(panel);
  }

  // Read-only overview of the current queue tickets across the board.
  function renderQueueOverview(tickets) {
    const root = $('#queueOverview');
    if (!root) return;
    root.innerHTML = '';
    const panel = el('div', { class: 'panel' }, [el('h3', null, `Fitting-room queue (${tickets.length})`)]);
    if (!tickets.length) {
      panel.appendChild(el('p', { class: 'muted' }, 'No active queue tickets.'));
    } else {
      panel.appendChild(el('table', { class: 'data' }, [
        el('tr', null, [el('th', null, 'Ticket'), el('th', null, 'Status'), el('th', null, 'Room'), el('th', null, 'Items')]),
      ].concat(tickets.map((t) => el('tr', null, [
        el('td', null, t.id),
        el('td', null, [el('span', { class: 'pill' }, String(t.status || '-'))]),
        el('td', null, String(t.fittingRoomId || '-')),
        el('td', null, String(t.itemCount != null ? t.itemCount : '-')),
      ])))));
    }
    root.appendChild(panel);
  }

  // ---- Queue ticket management ----
  function renderQueueMgmt() {
    const root = $('#queueMgmt');
    const out = el('div');
    const idInput = el('input', { type: 'text', id: 'qid', placeholder: 'queue ticket id (tkt-...)' });
    const panel = el('div', { class: 'panel' }, [
      el('h3', null, 'Manage fitting-room queue tickets (F11 lifecycle)'),
      el('p', { class: 'muted' }, 'Enter a ticket id a customer created, then confirm and advance it through the lifecycle, notify readiness, or record an exception.'),
      el('div', { class: 'composer' }, [idInput, el('button', { class: 'btn small', type: 'button', onclick: lookup }, 'Look up')]),
      out,
    ]);
    root.appendChild(panel);

    async function lookup() {
      const id = idInput.value.trim();
      if (!id) return;
      try {
        const ticket = await Api.getQueue(id);
        renderTicket(ticket, out);
      } catch (e) { out.innerHTML = `<p class="error-box">${e.message}</p>`; }
    }
  }

  function renderTicket(ticket, out) {
    out.innerHTML = '';
    out.appendChild(el('p', null, [el('strong', null, `Ticket ${ticket.id}`), document.createTextNode(` \u00b7 ${ticket.status}`)]));
    out.appendChild(el('div', { class: 'notice' }, ticket.liveStatusMessage || ''));
    const result = el('p', { class: 'muted' });

    const actions = el('div', { class: 'actions' });
    const run = async (fn) => {
      try { const t = await fn(); renderTicket(t, out); } catch (e) { result.textContent = `Action failed: ${e.message}`; out.appendChild(result); }
    };

    if (ticket.status === 'Requested') {
      actions.appendChild(el('button', { class: 'btn small', type: 'button', onclick: () => run(() => Api.confirmQueue(ticket.id, token())) }, 'Confirm place'));
    }
    ADVANCE_TARGETS.forEach((target) => {
      actions.appendChild(el('button', { class: 'btn small ghost', type: 'button', onclick: () => run(() => Api.advanceQueue(ticket.id, target, token())) },
        target === 'Ready' ? 'Notify Ready' : target === 'Completed' ? 'Record Completion' : `\u2192 ${target}`));
    });
    EXCEPTION_TARGETS.forEach((target) => {
      actions.appendChild(el('button', { class: 'btn small ghost', type: 'button', onclick: () => run(() => Api.advanceQueue(ticket.id, target, token())) }, `! ${target}`));
    });
    actions.appendChild(el('button', { class: 'btn small ghost', type: 'button', onclick: () => run(() => Api.cancelQueue(ticket.id)) }, 'Cancel'));
    out.appendChild(actions);
    out.appendChild(result);
  }

  async function createDemoTask() {
    try {
      setStatus('Creating demo picking request...');
      await Api.staffTask({
        userId: 'demo-shopper-001',
        garments: [{ sku: $('#demoSku').value.trim(), size: $('#demoSize').value.trim(), colour: $('#demoColour').value.trim() }],
      });
      setStatus('');
      await load();
    } catch (e) { setStatus(`Could not create task: ${e.message}`, true); }
  }

  $('#loadBtn').addEventListener('click', load);
  $('#createTaskBtn').addEventListener('click', createDemoTask);
  renderQueueMgmt();
  load();
})();
