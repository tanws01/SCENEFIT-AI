'use strict';

/**
 * SCENEFIT AI - customer shopping assistant flow (F01-F12).
 *
 * Vanilla browser JS, no framework, no CDN. Consumes the backend JSON API via
 * window.ScenefitApi (js/api.js). Renders exactly three coordinated outfit
 * cards, handles the "cannot form three" fallback, conversational refinement,
 * intent switching, profile + wardrobe panels, size guidance (with uncertainty
 * notice), virtual try-on (illustrative-aid label), store location, staff
 * assist, fitting-room queue tracking, and cart / checkout handoff.
 */

(function () {
  const Api = window.ScenefitApi;
  const USER_ID = 'demo-shopper-001';
  const CURRENCY = 'RM';

  // --- canonical demo scenarios (F: two one-click journeys) ---
  const DEMOS = {
    'port-dickson': {
      entry: 'style-my-moment',
      text: "I'm going to Port Dickson this Sunday for a sunset seafood dinner and photos. I want to look stylish and comfortable. Budget RM250.",
    },
    'latest-arrivals': {
      entry: 'explore-whats-new',
      text: "Show me the latest arrivals. I'm into relaxed tailoring and streetwear, under RM300.",
    },
  };

  // Canonical lifecycle order for the fitting-room queue tracker (F11).
  const QUEUE_FLOW = ['Requested', 'Confirmed', 'Picking Items', 'Waiting for Room', 'Ready', 'In Fitting Room', 'Completed'];
  const QUEUE_EXCEPTIONS = ['UnavailableItems', 'DelayedPreparation', 'CustomerCancelled', 'NoShow', 'ExpiredTicket'];

  const state = {
    sessionId: null,
    entryPoint: 'style-my-moment',
    lastRecommendation: null,
    wardrobe: [],
    queueTicketId: null,
    staffTaskId: null,
  };

  // ---- tiny DOM helpers ----
  const $ = (sel) => document.querySelector(sel);
  const el = (tag, attrs, children) => {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') node.className = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (v !== null && v !== undefined) node.setAttribute(k, v);
      }
    }
    for (const c of [].concat(children || [])) {
      if (c == null) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  };
  const rm = (n) => `${CURRENCY}${Number(n || 0).toFixed(2)}`;
  const setStatus = (msg, isError) => {
    const s = $('#status');
    s.textContent = msg || '';
    s.className = isError ? 'error-box' : 'spinner';
  };

  function productImage(sku) {
    // Served locally by the backend static handler (and Firebase Hosting).
    return `/assets/products/${encodeURIComponent(sku)}.png`;
  }

  // ---- session ----
  async function ensureSession() {
    if (state.sessionId) return state.sessionId;
    const res = await Api.startSession(USER_ID);
    state.sessionId = res.sessionId;
    return state.sessionId;
  }

  // ---- send a message ----
  async function sendMessage(text) {
    if (!text || !text.trim()) { setStatus('Please type or speak your request first.', true); return; }
    try {
      setStatus('Styling your looks with Gemini and validating every item against the catalogue...');
      await ensureSession();
      const res = await Api.sendMessage({
        sessionId: state.sessionId,
        userId: USER_ID,
        text: text.trim(),
      });
      state.sessionId = res.sessionId || state.sessionId;
      renderConversationMeta(res);
      renderRecommendation(res.recommendation, res.intent);
      setStatus('');
    } catch (e) {
      setStatus(`Could not get recommendations: ${e.message}`, true);
    }
  }

  async function refine(text) {
    if (!state.sessionId) return sendMessage(text);
    if (!text || !text.trim()) { setStatus('Type a refinement, e.g. "make it more casual, keep the shoes".', true); return; }
    try {
      setStatus('Refining your look...');
      const res = await Api.refine({ sessionId: state.sessionId, userId: USER_ID, text: text.trim() });
      renderConversationMeta(res, true);
      renderRecommendation(res.recommendation, res.intent);
      setStatus('');
    } catch (e) {
      setStatus(`Could not refine: ${e.message}`, true);
    }
  }

  function renderConversationMeta(res, isRefine) {
    const t = $('#transcript');
    if (res.transcript && res.transcript.transcript) {
      t.textContent = `Heard (${res.inputMode}): "${res.transcript.transcript}"`;
      t.classList.remove('hidden');
    } else { t.classList.add('hidden'); }

    const f = $('#followup');
    if (res.followUp && res.followUp.question) {
      f.textContent = `\u2753 ${res.followUp.question}`;
      f.classList.remove('hidden');
    } else { f.classList.add('hidden'); }

    if (isRefine && res.intentSwitched) {
      setStatus('Switched intent and re-styled your looks.');
    }
  }

  // ---- render recommendations ----
  function renderRecommendation(rec, intent) {
    const results = $('#results');
    results.innerHTML = '';
    if (!rec) return;

    if (rec.status === 'insufficient') {
      results.appendChild(renderInsufficient(rec));
      if (Array.isArray(rec.outfits) && rec.outfits.length) {
        const grid = el('div', { class: 'outfits' });
        rec.outfits.forEach((o) => grid.appendChild(renderOutfitCard(o)));
        results.appendChild(grid);
      }
      state.lastRecommendation = rec;
      return;
    }

    const header = el('div', { class: 'panel' }, [
      el('h3', null, `Three coordinated looks${rec.budget ? ` within ${rm(rec.budget.amountRm)}` : ''}`),
      el('p', { class: 'muted' }, intent && intent.wantsLatestCollection
        ? 'Built from the latest arrivals and tuned to your taste.'
        : 'Coordinated around your occasion. Every price, size, and stock figure is validated against the live catalogue.'),
    ]);
    results.appendChild(header);

    const grid = el('div', { class: 'outfits' });
    (rec.outfits || []).forEach((o) => grid.appendChild(renderOutfitCard(o)));
    results.appendChild(grid);
    state.lastRecommendation = rec;
  }

  function renderInsufficient(rec) {
    const box = el('div', { class: 'panel' });
    box.appendChild(el('div', { class: 'notice danger' }, rec.message
      || 'We could not build three complete outfits. Here are real catalogue pieces to start from - we never suggest items we do not stock.'));
    box.appendChild(el('p', { class: 'muted' }, `Formed ${rec.formed || 0} of 3 complete looks.`
      + (rec.minCompleteOutfitRm != null ? ` Most affordable complete outfit: ${rm(rec.minCompleteOutfitRm)}.` : '')));
    if (Array.isArray(rec.alternatives) && rec.alternatives.length) {
      box.appendChild(el('h4', null, 'Available alternatives'));
      const grid = el('div', { class: 'alt-grid' });
      rec.alternatives.forEach((a) => {
        grid.appendChild(el('div', { class: 'alt-card' }, [
          el('img', { src: productImage(a.sku), alt: a.name, style: 'width:100%;aspect-ratio:3/4;object-fit:cover;border-radius:8px;', onerror: imgFallback }),
          el('div', null, [el('strong', null, a.name)]),
          el('div', { class: 'muted' }, `${a.role} \u00b7 ${a.colour} \u00b7 ${rm(a.priceRm)}`),
          el('div', { class: 'muted' }, `Sizes: ${(a.availableSizes || []).join(', ') || 'n/a'}`),
        ]));
      });
      box.appendChild(grid);
    }
    return box;
  }

  function imgFallback(evt) {
    const img = evt.target;
    if (img.dataset.fallback) return;
    img.dataset.fallback = '1';
    img.src = '/assets/products/_placeholder.png';
  }

  function renderOutfitCard(o) {
    const heroSkus = (o.items || []).slice(0, 3);
    const hero = el('div', { class: 'hero' }, heroSkus.map((it) =>
      el('img', { src: productImage(it.sku), alt: it.name, loading: 'lazy', onerror: imgFallback })));

    const items = el('ul', { class: 'item-list' }, (o.items || []).map((it) =>
      el('li', null, [
        el('span', null, [
          el('span', { class: 'role-tag' }, it.role || it.category),
          document.createTextNode(it.name),
          el('div', { class: 'meta' }, `SKU ${it.sku} \u00b7 ${it.colour} \u00b7 size ${it.size} \u00b7 sizes: ${(it.availableSizes || []).join('/')}`),
        ]),
        el('span', { class: 'price' }, rm(it.priceRm)),
      ])));

    const totalRow = el('div', { class: 'total-row' }, [
      el('span', null, 'Total outfit cost'),
      el('span', { class: 'price' }, rm(o.totalPriceRm)),
    ]);

    const badges = el('div', null, [
      el('span', { class: 'badge ok' }, o.availability === 'in_stock' ? 'In stock' : (o.availability || 'available')),
      document.createTextNode(' '),
      o.budgetCompliant ? el('span', { class: 'badge budget' }, 'Within budget') : null,
    ]);

    const rationale = el('p', { class: 'rationale' }, [
      document.createTextNode(o.rationale || ''),
      el('span', { class: 'src' }, ` (${o.rationaleSource || 'styling suggestion'})`),
    ]);

    const fit = o.fitNote ? el('p', { class: 'fit-note' }, `Fit note: ${o.fitNote}`) : null;

    const actions = el('div', { class: 'actions' }, [
      actionBtn('Try on', () => openTryOn(o)),
      actionBtn('Compare', () => openCompare(o)),
      actionBtn('Swap', () => refineFocus(`Swap a piece in "${o.name}" for something different.`)),
      actionBtn('Save', () => saveOutfit(o)),
      actionBtn('Size guide', () => openSizeGuidance(o)),
      actionBtn('Find in store', () => openStoreLocation(o)),
      actionBtn('Request fitting room', () => requestQueue(o)),
      actionBtn('Add to cart & shop', () => addOutfitToCart(o), 'secondary'),
    ]);

    return el('div', { class: 'outfit-card' }, [
      hero,
      el('div', { class: 'body' }, [
        el('div', { class: 'theme' }, o.theme || 'look'),
        el('h4', null, o.name || 'Coordinated look'),
        badges,
        items,
        totalRow,
        rationale,
        fit,
        actions,
      ]),
    ]);
  }

  function actionBtn(label, handler, variant) {
    return el('button', { class: `btn small ${variant || 'ghost'}`, type: 'button', onclick: handler }, label);
  }

  function refineFocus(text) {
    $('#refineInput').value = text;
    $('#refineInput').focus();
  }

  // ---- tool panels ----
  function toolPanel(title, bodyNodes) {
    const container = $('#toolPanels');
    const panel = el('div', { class: 'panel' }, [
      el('div', { style: 'display:flex;justify-content:space-between;align-items:center;' }, [
        el('h3', null, title),
        el('button', { class: 'btn small ghost', type: 'button', onclick: () => panel.remove() }, 'Close'),
      ]),
    ].concat(bodyNodes || []));
    container.prepend(panel);
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return panel;
  }

  // F05 virtual try-on
  async function openTryOn(o) {
    const panel = toolPanel(`Virtual try-on \u00b7 ${o.name}`, [el('p', { class: 'spinner' }, 'Generating illustrative preview with Vertex AI...')]);
    try {
      const res = await Api.tryOn({ skus: o.skus || (o.items || []).map((i) => i.sku) });
      panel.querySelector('.spinner').remove();
      panel.appendChild(el('div', { class: 'notice illustrative' },
        res.compositeLabel || res.disclaimer
        || 'Illustrative composite preview only - not a guarantee of fit, colour, drape, or measurements.'));
      panel.appendChild(el('div', { class: 'tryon-preview' }, [
        el('div', { class: 'tryon-frame' }, [
          svgPreviewFor(o),
          el('p', { class: 'muted' }, `Illustrative aid \u00b7 ${(res.skus || []).join(', ')}`),
        ]),
      ]));
      panel.appendChild(el('p', { class: 'hint' }, 'Add an optional photo and compare looks or switch garments/colours. This visual never guarantees fit.'));
    } catch (e) {
      panel.appendChild(el('div', { class: 'error-box' }, `Try-on failed: ${e.message}`));
    }
  }

  async function openCompare(o) {
    const rec = state.lastRecommendation;
    const others = (rec && rec.outfits || []).filter((x) => x.id !== o.id);
    const other = others[0];
    const panel = toolPanel('Compare looks', []);
    panel.appendChild(el('div', { class: 'notice illustrative' }, 'Side-by-side comparison. Composite visuals are illustrative aids only.'));
    const grid = el('div', { class: 'tryon-preview', style: 'grid-template-columns:1fr 1fr;' }, [
      el('div', { class: 'tryon-frame' }, [svgPreviewFor(o), el('p', { class: 'muted' }, `${o.name} \u00b7 ${rm(o.totalPriceRm)}`)]),
      other ? el('div', { class: 'tryon-frame' }, [svgPreviewFor(other), el('p', { class: 'muted' }, `${other.name} \u00b7 ${rm(other.totalPriceRm)}`)]) : el('div', { class: 'muted' }, 'No second look to compare.'),
    ]);
    panel.appendChild(grid);
  }

  // Build a simple inline SVG swatch board from item colours (no network).
  function svgPreviewFor(o) {
    const colours = (o.items || []).map((i) => colourHex(i.colour));
    const w = 240, h = 300;
    const parts = colours.map((c, i) => `<rect x="${20 + i * 48}" y="40" width="40" height="${220}" rx="6" fill="${c}" stroke="#d8d2c8"/>`).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Illustrative outfit swatch">
      <rect width="${w}" height="${h}" fill="#f6f2ec"/>
      <text x="${w / 2}" y="24" text-anchor="middle" font-size="12" fill="#4a4857">Illustrative composite</text>
      ${parts}
      <text x="${w / 2}" y="${h - 14}" text-anchor="middle" font-size="11" fill="#6b4de6">${(o.name || 'Look').slice(0, 32)}</text>
    </svg>`;
    const wrap = el('div');
    wrap.innerHTML = svg;
    return wrap.firstChild;
  }

  function colourHex(name) {
    const map = {
      cream: '#efe7d6', white: '#f7f5f0', beige: '#e4d5bb', navy: '#2a3450', black: '#2a2a2e',
      olive: '#6b6b3a', grey: '#9a9aa0', brown: '#7a5a3c', khaki: '#b7a884', blue: '#4a6fa5',
    };
    return map[String(name || '').toLowerCase()] || '#c9c2b6';
  }

  // F06 size guidance with uncertainty notice
  async function openSizeGuidance(o) {
    const topItem = (o.items || []).find((i) => i.category === 'top') || (o.items || [])[0];
    const panel = toolPanel(`Size guidance \u00b7 ${topItem ? topItem.name : o.name}`, []);
    const chest = el('input', { type: 'number', id: 'sgChest', placeholder: 'e.g. 99' });
    const pref = el('input', { type: 'text', id: 'sgPref', placeholder: 'e.g. M' });
    panel.appendChild(el('div', { class: 'row' }, [
      el('div', null, [el('label', null, 'Chest (cm, optional)'), chest]),
      el('div', null, [el('label', null, 'Preferred size (optional)'), pref]),
    ]));
    const out = el('div');
    panel.appendChild(el('div', { class: 'actions' }, [
      el('button', { class: 'btn small', type: 'button', onclick: run }, 'Get guidance'),
    ]));
    panel.appendChild(out);

    async function run() {
      out.innerHTML = '<p class="spinner">Checking retailer size charts...</p>';
      try {
        const res = await Api.sizeGuidance({
          sku: topItem && topItem.sku,
          category: topItem && topItem.category,
          measurements: chest.value ? { chest: Number(chest.value) } : undefined,
          preferredSize: pref.value || undefined,
        });
        out.innerHTML = '';
        out.appendChild(el('p', null, [el('strong', null, `Suggested size: ${res.suggestedSize || 'n/a'}`), document.createTextNode(` (${res.confidence})`)]));
        if (res.rationale) out.appendChild(el('p', { class: 'muted' }, res.rationale));
        if (res.alternatives && res.alternatives.length) {
          out.appendChild(el('p', { class: 'muted' }, `Alternatives: ${res.alternatives.map((a) => `${a.size} (${a.relation})`).join(', ')}`));
        }
        (res.uncertaintyNotices || []).forEach((n) => out.appendChild(el('div', { class: 'notice' }, n)));
      } catch (e) {
        out.innerHTML = `<p class="error-box">Size guidance failed: ${e.message}</p>`;
      }
    }
  }

  // F09 store location
  async function openStoreLocation(o) {
    const first = (o.items || [])[0];
    const panel = toolPanel(`Find in store \u00b7 ${o.name}`, [el('p', { class: 'spinner' }, 'Looking up rack location...')]);
    try {
      const res = await Api.locate(first.sku);
      panel.querySelector('.spinner').remove();
      if (!res.found) {
        panel.appendChild(el('div', { class: 'notice' }, res.message || 'Location unavailable - please ask a store associate.'));
        panel.appendChild(el('div', { class: 'actions' }, [el('button', { class: 'btn small', type: 'button', onclick: () => requestStaffAssist(o) }, 'Request staff assistance')]));
        return;
      }
      const L = res.location;
      panel.appendChild(el('p', null, [el('strong', null, res.productName || first.name)]));
      const dl = el('dl', { class: 'loc-grid' });
      [['Store', L.store], ['Floor', L.floor], ['Zone', L.zone], ['Aisle', L.aisle], ['Rack', L.rack], ['Position', L.position]].forEach(([k, v]) => {
        if (!v && v !== 0) return;
        dl.appendChild(el('dt', null, k));
        dl.appendChild(el('dd', null, String(v)));
      });
      panel.appendChild(dl);
      panel.appendChild(el('div', { class: 'notice illustrative' }, `Directions: ${res.directions}`));
      panel.appendChild(el('div', { class: 'actions' }, [el('button', { class: 'btn small', type: 'button', onclick: () => requestStaffAssist(o) }, 'Ask staff to pull these items')]));
    } catch (e) {
      panel.querySelector('.spinner').textContent = `Lookup failed: ${e.message}`;
    }
  }

  // F10 staff assist
  async function requestStaffAssist(o) {
    try {
      setStatus('Sending picking request to store staff...');
      const res = await Api.staffTask({
        userId: USER_ID,
        garments: (o.items || []).map((i) => ({ sku: i.sku, size: i.size, colour: i.colour })),
      });
      state.staffTaskId = res.id;
      setStatus('');
      toolPanel('Staff assistance requested (F10)', [
        el('p', null, res.customerStatus || 'Your request has been sent to a store associate.'),
        el('p', { class: 'muted' }, `Task ${res.id} \u00b7 status: ${res.status}`),
        el('ul', { class: 'item-list' }, (res.garments || []).map((g) =>
          el('li', null, [el('span', null, `${g.name || g.sku} \u00b7 size ${g.size || '-'} \u00b7 ${g.colour || '-'}`),
            el('span', { class: 'badge ' + (g.available ? 'ok' : 'budget') }, g.available === false ? 'check stock' : 'available')]))),
      ]);
    } catch (e) {
      setStatus(`Staff request failed: ${e.message}`, true);
    }
  }

  // F11 fitting-room queue
  async function requestQueue(o) {
    try {
      setStatus('Requesting a fitting-room place...');
      const res = await Api.requestQueue({
        userId: USER_ID,
        items: (o.items || []).map((i) => ({ sku: i.sku, size: i.size, colour: i.colour })),
      });
      setStatus('');
      if (!res.supported) {
        toolPanel('Fitting-room queue (F11)', [el('div', { class: 'notice danger' }, res.message || 'This branch does not support fitting-room queue requests.')]);
        return;
      }
      state.queueTicketId = res.ticket.id;
      renderQueueTracker(res.ticket);
    } catch (e) {
      setStatus(`Queue request failed: ${e.message}`, true);
    }
  }

  function renderQueueTracker(ticket) {
    const existing = document.getElementById(`queue-${ticket.id}`);
    const body = [];
    body.push(el('p', null, [el('strong', null, `Ticket ${ticket.id}`), document.createTextNode(` \u00b7 ${ticket.storeName || ''}`)]));
    body.push(el('div', { class: 'notice' }, ticket.liveStatusMessage || ''));

    const isException = QUEUE_EXCEPTIONS.includes(ticket.status);
    const currentIdx = QUEUE_FLOW.indexOf(ticket.status);
    const steps = el('ul', { class: 'queue-steps' }, QUEUE_FLOW.map((s, i) => {
      let cls = '';
      if (!isException) {
        if (i < currentIdx) cls = 'done';
        else if (i === currentIdx) cls = 'current';
      } else if (i === 0) { cls = 'done'; }
      return el('li', { class: cls }, [el('span', { class: 'dot' }), document.createTextNode(s)]);
    }));
    body.push(steps);
    if (isException) {
      body.push(el('div', { class: 'notice danger' }, `Exception: ${ticket.status}`));
    }
    body.push(el('div', { class: 'actions' }, [
      el('button', { class: 'btn small', type: 'button', onclick: () => refreshQueue(ticket.id) }, 'Refresh status'),
      el('button', { class: 'btn small ghost', type: 'button', onclick: () => cancelQueue(ticket.id) }, 'Cancel (you stay in control)'),
    ]));
    body.push(el('p', { class: 'hint' }, 'Lifecycle: Requested \u2192 Confirmed \u2192 Picking Items \u2192 Waiting for Room \u2192 Ready \u2192 In Fitting Room \u2192 Completed. The store confirms your place - we never promise it before that.'));

    if (existing) {
      existing.innerHTML = '';
      body.forEach((n) => existing.appendChild(n));
    } else {
      const panel = toolPanel('Fitting-room queue (F11)', body);
      panel.id = `queue-${ticket.id}`;
    }
  }

  async function refreshQueue(id) {
    try {
      const ticket = await Api.getQueue(id);
      renderQueueTracker(ticket);
    } catch (e) { setStatus(`Could not refresh queue: ${e.message}`, true); }
  }
  async function cancelQueue(id) {
    try {
      const ticket = await Api.cancelQueue(id);
      renderQueueTracker(ticket);
    } catch (e) { setStatus(`Could not cancel: ${e.message}`, true); }
  }

  // F12 cart & checkout handoff
  async function saveOutfit(o) {
    try {
      await Api.addToCart({ userId: USER_ID, outfit: { id: o.id, name: o.name, items: o.items, totalPriceRm: o.totalPriceRm } });
      setStatus(`Saved "${o.name}" for comparison.`);
    } catch (e) { setStatus(`Save failed: ${e.message}`, true); }
  }

  async function addOutfitToCart(o) {
    try {
      setStatus('Adding items to your cart...');
      for (const it of o.items || []) {
        await Api.addToCart({ userId: USER_ID, item: { sku: it.sku, size: it.size, colour: it.colour, quantity: 1 } });
      }
      const cart = await Api.getCart(USER_ID);
      setStatus('');
      renderCart(cart);
    } catch (e) { setStatus(`Add to cart failed: ${e.message}`, true); }
  }

  function renderCart(payload) {
    const cart = payload.cart || payload;
    const body = [];
    body.push(el('ul', { class: 'item-list' }, (cart.items || []).map((i) =>
      el('li', null, [el('span', null, `${i.name || i.sku} \u00b7 ${i.colour || ''} \u00b7 size ${i.size || '-'} \u00d7${i.quantity}`), el('span', { class: 'price' }, i.priceRm != null ? rm(i.priceRm) : 'n/a')]))));
    const total = (cart.items || []).reduce((s, i) => s + (Number(i.priceRm) || 0) * (i.quantity || 1), 0);
    body.push(el('div', { class: 'total-row' }, [el('span', null, 'Cart total'), el('span', { class: 'price' }, rm(total))]));
    body.push(el('div', { class: 'notice' }, 'SCENEFIT never processes payment. Checkout hands off to the retailer\'s secure checkout/POS - you stay in control.'));
    const out = el('div');
    body.push(el('div', { class: 'actions' }, [
      el('button', { class: 'btn small', type: 'button', onclick: () => handoff('online') }, 'Checkout online (handoff)'),
      el('button', { class: 'btn small ghost', type: 'button', onclick: () => handoff('physical') }, 'Shop in store'),
    ]));
    body.push(out);
    toolPanel('Cart & checkout handoff (F12)', body);

    async function handoff(mode) {
      try {
        const res = await Api.checkoutHandoff({ userId: USER_ID, mode });
        out.innerHTML = '';
        out.appendChild(el('div', { class: 'notice' }, res.disclaimer));
        out.appendChild(el('p', null, res.instruction || ''));
        if (res.checkoutUrl) out.appendChild(el('p', { class: 'muted' }, `Handoff link: ${res.checkoutUrl}`));
        out.appendChild(el('p', { class: 'muted' }, `Estimated total: ${rm(res.estimatedTotalRm)} (${res.itemCount} items)`));
      } catch (e) {
        out.innerHTML = `<p class="error-box">Checkout handoff failed: ${e.message}</p>`;
      }
    }
  }

  // ---- profile (F03) ----
  async function saveProfile() {
    const splitList = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);
    try {
      const profile = {
        sizes: { top: $('#pfSizeTop').value || undefined, footwear: $('#pfSizeShoe').value || undefined },
        preferredStyles: splitList($('#pfStyles').value),
        preferredColours: splitList($('#pfColours').value),
        avoidedColours: splitList($('#pfAvoid').value),
      };
      await Api.putProfile(USER_ID, profile);
      $('#profileStatus').textContent = 'Profile saved. Future looks will use these preferences.';
    } catch (e) {
      $('#profileStatus').textContent = `Could not save profile: ${e.message}`;
    }
  }

  // ---- wardrobe (F08) ----
  function addWardrobeItem() {
    const v = $('#wardrobeInput').value.trim();
    if (!v) return;
    state.wardrobe.push(v);
    $('#wardrobeInput').value = '';
    renderWardrobe();
  }
  function renderWardrobe() {
    const list = $('#wardrobeList');
    list.innerHTML = '';
    state.wardrobe.forEach((w, idx) => {
      list.appendChild(el('li', null, [
        el('span', null, `${w} `),
        el('span', { class: 'muted' }, '(owned - RM0.00 purchase cost)'),
        el('button', { class: 'btn small ghost', type: 'button', style: 'margin-left:auto;', onclick: () => { state.wardrobe.splice(idx, 1); renderWardrobe(); } }, 'Remove'),
      ]));
    });
  }

  // ---- entry points & demo ----
  function selectEntry(entry) {
    state.entryPoint = entry;
    $('#entryMoment').classList.toggle('active', entry === 'style-my-moment');
    $('#entryNew').classList.toggle('active', entry === 'explore-whats-new');
    $('#composerTitle').textContent = entry === 'explore-whats-new'
      ? 'Explore the latest arrivals' : 'Tell me about your moment';
    $('#messageInput').placeholder = entry === 'explore-whats-new'
      ? "e.g. Show me the latest arrivals. I'm into relaxed tailoring and streetwear, under RM300."
      : "e.g. I'm going to Port Dickson this Sunday for a sunset seafood dinner and photos. Stylish and comfortable. Budget RM250.";
  }

  function runDemo(key) {
    const d = DEMOS[key];
    if (!d) return;
    selectEntry(d.entry);
    $('#messageInput').value = d.text;
    sendMessage(d.text);
  }

  // ---- voice input (F: voice affordance with graceful text fallback) ----
  let recognition = null;
  function setupVoice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const micBtn = $('#micBtn');
    if (!SR) {
      // Graceful fallback: voice simply pre-fills via the server mock speech path.
      micBtn.addEventListener('click', () => {
        $('#voiceHint').textContent = 'Live microphone is unavailable here; using the Google Speech-to-Text mock transcript instead.';
        sendVoiceMock();
      });
      return;
    }
    recognition = new SR();
    recognition.lang = 'en-MY';
    recognition.interimResults = false;
    micBtn.addEventListener('click', () => {
      try {
        micBtn.classList.add('recording');
        recognition.start();
      } catch (_e) { micBtn.classList.remove('recording'); }
    });
    recognition.onresult = (ev) => {
      const text = ev.results[0][0].transcript;
      $('#messageInput').value = text;
      micBtn.classList.remove('recording');
      sendMessage(text);
    };
    recognition.onerror = () => { micBtn.classList.remove('recording'); sendVoiceMock(); };
    recognition.onend = () => micBtn.classList.remove('recording');
  }

  // Fallback: send a voiceRef so the server-side Speech-to-Text mock transcribes it.
  async function sendVoiceMock() {
    try {
      setStatus('Transcribing voice with Google Speech-to-Text (mock) and styling...');
      await ensureSession();
      const res = await Api.sendMessage({ sessionId: state.sessionId, userId: USER_ID, voiceRef: 'demo-voice-port-dickson' });
      state.sessionId = res.sessionId || state.sessionId;
      if (res.transcript && res.transcript.transcript) $('#messageInput').value = res.transcript.transcript;
      renderConversationMeta(res);
      renderRecommendation(res.recommendation, res.intent);
      setStatus('');
    } catch (e) {
      setStatus(`Voice path failed, please type instead: ${e.message}`, true);
    }
  }

  // ---- wire up ----
  function init() {
    document.querySelectorAll('[data-entry]').forEach((node) => {
      node.addEventListener('click', () => selectEntry(node.dataset.entry));
      node.addEventListener('keypress', (e) => { if (e.key === 'Enter' || e.key === ' ') selectEntry(node.dataset.entry); });
    });
    document.querySelectorAll('[data-demo]').forEach((btn) =>
      btn.addEventListener('click', () => runDemo(btn.dataset.demo)));

    $('#sendBtn').addEventListener('click', () => sendMessage($('#messageInput').value));
    $('#refineBtn').addEventListener('click', () => refine($('#refineInput').value));
    $('#saveProfileBtn').addEventListener('click', saveProfile);
    $('#addWardrobeBtn').addEventListener('click', addWardrobeItem);

    // Reveal optional panels after first interaction so they are discoverable.
    $('#profilePanel').classList.remove('hidden');
    $('#wardrobePanel').classList.remove('hidden');

    selectEntry('style-my-moment');
    setupVoice();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
