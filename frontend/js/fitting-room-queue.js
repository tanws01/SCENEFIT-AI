'use strict';

/**
 * SCENEFIT AI - dedicated Fitting Room Queue page.
 *
 * A single standalone page with two tabs onto the F11 fitting-room queue:
 *
 *   Tab 1 - Customer view (OPEN, no token):
 *     - request a place            -> POST /api/queue        (Api.requestQueue)
 *     - track a ticket             -> GET  /api/queue/:id     (Api.getQueue)
 *     - cancel own ticket          -> POST /api/queue/:id/cancel (Api.cancelQueue)
 *     The customer stays in control; cancel needs NO staff token.
 *
 *   Tab 2 - Staff pickup / manage (ROLE-GATED write actions):
 *     - list current tickets       -> GET  /api/dashboard/staff (OPEN read)
 *     - confirm the place          -> POST /api/queue/:id/confirm  (token)
 *     - advance / notify / complete / exception -> POST /api/queue/:id/advance (token)
 *     - cancel                     -> POST /api/queue/:id/cancel (open)
 *
 * The backend owns the strict F11 state machine and role-gating; this UI never
 * replicates that logic - it just surfaces the backend error message when an
 * action is illegal. No external/CDN calls, Google-only, offline-safe.
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

  const token = () => { const t = $('#token'); return t ? t.value.trim() : ''; };

  // Queue lifecycle targets staff can push a ticket toward (confirm is separate).
  // Mirrors the staff dashboard's ADVANCE_TARGETS / EXCEPTION_TARGETS sets.
  const ADVANCE_TARGETS = ['Picking Items', 'Waiting for Room', 'Ready', 'In Fitting Room', 'Completed'];
  const EXCEPTION_TARGETS = ['UnavailableItems', 'DelayedPreparation', 'NoShow', 'ExpiredTicket'];

  // =====================================================================
  // Tab switcher (accessible, keyboard-friendly, no libraries).
  // =====================================================================
  const TABS = [
    { tab: '#tab-customer', panel: '#panel-customer' },
    { tab: '#tab-staff', panel: '#panel-staff' },
  ];

  function selectTab(index) {
    TABS.forEach((t, i) => {
      const tabEl = $(t.tab);
      const panelEl = $(t.panel);
      const active = i === index;
      if (tabEl) {
        tabEl.setAttribute('aria-selected', active ? 'true' : 'false');
        tabEl.setAttribute('tabindex', active ? '0' : '-1');
        tabEl.classList.toggle('active', active);
      }
      if (panelEl) {
        if (active) panelEl.removeAttribute('hidden');
        else panelEl.setAttribute('hidden', '');
      }
    });
  }

  function wireTabs() {
    TABS.forEach((t, i) => {
      const tabEl = $(t.tab);
      if (!tabEl) return;
      tabEl.addEventListener('click', () => selectTab(i));
      tabEl.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          const next = e.key === 'ArrowRight' ? (i + 1) % TABS.length : (i - 1 + TABS.length) % TABS.length;
          selectTab(next);
          const nextTab = $(TABS[next].tab);
          if (nextTab) nextTab.focus();
        }
      });
    });
    // Default to the Customer tab.
    selectTab(0);
  }

  // =====================================================================
  // Shared ticket renderer.
  //   mode === 'staff' adds the role-gated lifecycle actions (confirm/advance/
  //   exception). Both modes expose the open customer Cancel action.
  // =====================================================================
  function renderTicketInto(ticket, out, mode) {
    out.innerHTML = '';
    out.appendChild(el('p', null, [
      el('strong', null, `Ticket ${ticket.id}`),
      document.createTextNode(` \u00b7 ${ticket.status}`),
    ]));
    if (ticket.liveStatusMessage) out.appendChild(el('div', { class: 'notice' }, ticket.liveStatusMessage));

    const meta = el('dl', { class: 'loc-grid' });
    meta.appendChild(el('dt', null, 'Current state'));
    meta.appendChild(el('dd', null, String(ticket.status || '-')));
    meta.appendChild(el('dt', null, 'Assigned fitting room'));
    meta.appendChild(el('dd', null, String(ticket.fittingRoomId || 'not assigned yet')));
    out.appendChild(meta);

    const items = ticket.items || ticket.garments || [];
    if (items.length) {
      out.appendChild(el('p', { class: 'muted' }, `Items (${items.length})`));
      out.appendChild(el('ul', { class: 'item-list' }, items.map((g) => {
        const sku = typeof g === 'string' ? g : (g.sku || g.id || '-');
        const detail = typeof g === 'string'
          ? ''
          : [g.size ? `size ${g.size}` : null, g.colour || g.color || null].filter(Boolean).join(' \u00b7 ');
        return el('li', null, [
          el('span', null, String(sku)),
          detail ? el('span', { class: 'meta' }, detail) : null,
        ]);
      })));
    }

    const result = el('p', { class: 'muted' });
    const actions = el('div', { class: 'actions' });
    const run = async (fn) => {
      try { const t = await fn(); renderTicketInto(t, out, mode); }
      catch (e) { result.textContent = `Action failed: ${e.message}`; out.appendChild(result); }
    };

    if (mode === 'staff') {
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
    }

    // Cancel is OPEN for both views - the customer stays in control, no token.
    actions.appendChild(el('button', { class: 'btn small ghost', type: 'button', onclick: () => run(() => Api.cancelQueue(ticket.id)) }, 'Cancel ticket'));
    out.appendChild(actions);
    out.appendChild(result);
  }

  // =====================================================================
  // Tab 1: Customer view (open actions only).
  // =====================================================================
  function wireCustomer() {
    const idInput = $('#custTicketId');
    const out = $('#custTicket');

    async function lookup() {
      const id = idInput.value.trim();
      if (!id) return;
      out.innerHTML = '<p class="spinner">Looking up ticket...</p>';
      try {
        const ticket = await Api.getQueue(id);
        renderTicketInto(ticket, out, 'customer');
      } catch (e) { out.innerHTML = `<p class="error-box">${e.message}</p>`; }
    }
    $('#custLookupBtn').addEventListener('click', lookup);
    idInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') lookup(); });

    async function request() {
      const raw = $('#custItems').value.trim();
      const items = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean).map((sku) => ({ sku })) : [];
      const res = $('#custRequestResult');
      res.innerHTML = '<p class="spinner">Requesting a place...</p>';
      try {
        const ticket = await Api.requestQueue({ userId: 'demo-shopper-001', items });
        res.innerHTML = '';
        res.appendChild(el('div', { class: 'notice illustrative' }, `Ticket ${ticket.id} created. Track it above or manage it from the Staff tab.`));
        // Pre-fill the tracker so the customer can immediately follow their ticket.
        idInput.value = ticket.id;
        renderTicketInto(ticket, out, 'customer');
      } catch (e) { res.innerHTML = `<p class="error-box">${e.message}</p>`; }
    }
    $('#custRequestBtn').addEventListener('click', request);
  }

  // =====================================================================
  // Tab 2: Staff pickup / manage.
  // =====================================================================
  function wireStaff() {
    const setStatus = (m, err) => {
      const s = $('#staffStatus');
      s.textContent = m || '';
      s.className = err ? 'error-box' : 'muted';
    };

    async function loadBoard() {
      setStatus('Loading queue board...');
      try {
        const data = await Api.staffDashboard();
        renderBoard(data.queueTickets || []);
        setStatus('');
      } catch (e) { setStatus(`Failed to load board: ${e.message}`, true); }
    }

    function renderBoard(tickets) {
      const root = $('#staffQueueBoard');
      root.innerHTML = '';
      const panel = el('div', { class: 'panel' }, [el('h3', null, `Fitting-room queue (${tickets.length})`)]);
      if (!tickets.length) {
        panel.appendChild(el('p', { class: 'muted' }, 'No fitting-room queue tickets yet. A customer can request a place from the Customer tab, or marking a picking task ready for collection adds one.'));
      } else {
        panel.appendChild(el('table', { class: 'data' }, [
          el('tr', null, [el('th', null, 'Ticket'), el('th', null, 'Status'), el('th', null, 'Room'), el('th', null, 'Items'), el('th', null, 'Source task'), el('th', null, '')]),
        ].concat(tickets.map((t) => el('tr', null, [
          el('td', null, String(t.id)),
          el('td', null, [el('span', { class: 'pill' }, String(t.status || '-'))]),
          el('td', null, String(t.fittingRoomId || '-')),
          el('td', null, String(t.itemCount != null ? t.itemCount : '-')),
          el('td', null, String(t.sourceTaskId || '-')),
          el('td', null, [el('button', {
            class: 'btn small ghost', type: 'button',
            onclick: () => { $('#staffTicketId').value = t.id; lookup(); },
          }, 'Manage')]),
        ])))));
      }
      root.appendChild(panel);
    }

    async function lookup() {
      const id = $('#staffTicketId').value.trim();
      const out = $('#staffTicket');
      if (!id) return;
      out.innerHTML = '<p class="spinner">Looking up ticket...</p>';
      try {
        const ticket = await Api.getQueue(id);
        renderTicketInto(ticket, out, 'staff');
      } catch (e) { out.innerHTML = `<p class="error-box">${e.message}</p>`; }
    }

    $('#staffRefreshBtn').addEventListener('click', loadBoard);
    $('#staffLookupBtn').addEventListener('click', lookup);
    $('#staffTicketId').addEventListener('keydown', (e) => { if (e.key === 'Enter') lookup(); });
    loadBoard();
  }

  wireTabs();
  wireCustomer();
  wireStaff();
})();
