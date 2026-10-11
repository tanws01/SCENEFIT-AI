'use strict';

/**
 * SCENEFIT AI - Retailer Intelligence Dashboard (F13) + Merchandising
 * Insights (F15). Consumes /api/dashboard/retail and
 * /api/dashboard/merchandising (gated by Firebase Auth role).
 *
 * Renders aggregated, privacy-protected data only. F15 insights are labelled
 * as human decision-support, never guaranteed forecasts or auto-reorder.
 */

(function () {
  const Api = window.ScenefitApi;

  const $ = (s) => document.querySelector(s);
  const el = (tag, attrs, children) => {
    const n = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v; else if (v != null) n.setAttribute(k, v);
    }
    for (const c of [].concat(children || [])) {
      if (c == null) continue;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return n;
  };
  const setStatus = (m, err) => { const s = $('#status'); s.textContent = m || ''; s.className = err ? 'error-box' : 'spinner'; };

  // CSS-only bar chart from [{key,count}] rows.
  function barChart(rows, valueKey) {
    const vk = valueKey || 'count';
    const max = Math.max(1, ...rows.map((r) => Number(r[vk]) || 0));
    const chart = el('div', { class: 'barchart' });
    rows.forEach((r) => {
      const val = Number(r[vk]) || 0;
      chart.appendChild(el('div', { class: 'bar-row' }, [
        el('span', null, String(r.key != null ? r.key : r.metric || '')),
        el('div', { class: 'bar-track' }, [el('div', { class: 'bar-fill', style: `width:${(val / max) * 100}%` })]),
        el('span', { class: 'bar-val' }, String(val)),
      ]));
    });
    return chart;
  }

  function table(rows, cols) {
    const t = el('table', { class: 'data' });
    t.appendChild(el('tr', null, cols.map((c) => el('th', null, c.label))));
    (rows || []).forEach((r) => t.appendChild(el('tr', null, cols.map((c) => el('td', null, String(r[c.key] != null ? r[c.key] : '-'))))));
    return t;
  }

  function sectionPanel(title, nodes) {
    return el('div', { class: 'panel' }, [el('h3', null, title)].concat(nodes || []));
  }

  async function load() {
    const token = $('#token').value.trim();
    setStatus('Loading retailer intelligence...');
    $('#retail').innerHTML = '';
    $('#merch').innerHTML = '';
    try {
      const [retail, merch] = await Promise.all([
        Api.retailDashboard(token),
        Api.merchandisingInsights(token),
      ]);
      $('#authStatus').textContent = 'Authenticated. Showing aggregated, privacy-protected data.';
      renderRetail(retail);
      renderMerch(merch);
      setStatus('');
    } catch (e) {
      setStatus('', false);
      $('#authStatus').textContent = e.status === 401 || e.status === 403
        ? `Access denied (${e.status}). Use a merchandiser/ops/admin token.`
        : `Failed to load: ${e.message}`;
    }
  }

  function renderRetail(data) {
    const root = $('#retail');
    root.appendChild(el('div', { class: 'notice' }, (data.privacy && data.privacy.note)
      || 'Aggregated, privacy-protected data with retention/access controls.'));

    const s = data.sections || {};
    // 1. Shopping Intent
    root.appendChild(sectionPanel('1 \u00b7 ' + (s.shoppingIntent && s.shoppingIntent.title || 'Shopping Intent'), [
      el('p', { class: 'muted' }, 'Occasion-based vs latest-collection demand; popular occasions.'),
      barChart(s.shoppingIntent && s.shoppingIntent.popularOccasions || []),
    ]));
    // 2. Product Demand
    root.appendChild(sectionPanel('2 \u00b7 ' + (s.productDemand && s.productDemand.title || 'Product Demand'), [
      el('p', { class: 'muted' }, 'Most requested styles / preferences.'),
      barChart(s.productDemand && s.productDemand.mostRequestedStyles || []),
    ]));
    // 3. Unmet Demand
    root.appendChild(sectionPanel('3 \u00b7 ' + (s.unmetDemand && s.unmetDemand.title || 'Unmet Demand'), [
      el('p', { class: 'muted' }, 'Reasons requests could not be fulfilled (e.g. missing sizes).'),
      table(s.unmetDemand && s.unmetDemand.reasons || [], [{ key: 'key', label: 'Reason' }, { key: 'count', label: 'Count' }]),
    ]));
    // 4. In-Store Experience
    root.appendChild(sectionPanel('4 \u00b7 ' + (s.inStoreExperience && s.inStoreExperience.title || 'In-Store Experience'), [
      el('p', { class: 'muted' }, 'Activity by zone / location-lookup volume.'),
      barChart(s.inStoreExperience && s.inStoreExperience.activityByZone || []),
    ]));
    // 5. Commercial Performance
    root.appendChild(sectionPanel('5 \u00b7 ' + (s.commercialPerformance && s.commercialPerformance.title || 'Commercial Performance'), [
      el('p', { class: 'muted' }, 'Checkout handoffs and value.'),
      table(s.commercialPerformance && s.commercialPerformance.checkoutHandoffs || [], [
        { key: 'metric', label: 'Metric' }, { key: 'count', label: 'Count' }, { key: 'totalValueRm', label: 'Total (RM)' },
      ]),
    ]));
  }

  function renderMerch(data) {
    const root = $('#merch');
    const panel = el('div', { class: 'panel' });
    panel.appendChild(el('span', { class: 'tag-label' }, 'HUMAN DECISION-SUPPORT'));
    panel.appendChild(el('h3', null, 'Merchandising &amp; Inventory Insights (F15)'));
    const ds = data.decisionSupport || {};
    panel.appendChild(el('div', { class: 'notice' }, ds.note
      || 'These insights support HUMAN merchandising decisions. They are NOT guaranteed forecasts and NOT automatic instructions to reorder stock.'));

    const insights = data.insights || {};
    Object.keys(insights).forEach((key) => {
      const ins = insights[key];
      panel.appendChild(el('div', { class: 'section-title' }, ins.label || key));
      panel.appendChild(el('p', { class: 'muted' }, `Interpretation: ${ins.interpretation || 'decision-support'}`));
      panel.appendChild(table(ins.data || [], [
        { key: 'key', label: 'Signal' }, { key: 'count', label: 'Count' },
      ]));
    });
    root.appendChild(panel);
  }

  $('#loadBtn').addEventListener('click', load);
  // Auto-load with the default demo token.
  load();
})();
