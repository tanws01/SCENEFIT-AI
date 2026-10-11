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
    $('#ai').innerHTML = '';
    $('#merch').innerHTML = '';
    try {
      const [retail, merch] = await Promise.all([
        Api.retailDashboard(token),
        Api.merchandisingInsights(token),
      ]);
      $('#authStatus').textContent = 'Authenticated. Showing aggregated, privacy-protected data.';
      renderRetail(retail);
      // AI analysis / predictions panel - distinct from the hard numbers. Reads
      // from retail.aiInsights (preferred) or merch.aiAnalysis as a fallback.
      renderAiInsights(retail.aiInsights || (merch && merch.aiAnalysis) || null);
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

  // Render the model-generated AI analysis / predictions / suggestions in a
  // clearly-labelled, visually-distinct panel. Degrades gracefully: if there
  // is no AI block (e.g. no gemini adapter wired), nothing is rendered.
  function renderAiInsights(ai) {
    const root = $('#ai');
    if (!ai) return;
    const panel = el('div', { class: 'panel ai-panel' });
    panel.appendChild(el('span', { class: 'tag-label ai' }, 'AI \u00b7 MODEL-GENERATED \u00b7 NON-GUARANTEED'));
    panel.appendChild(el('h3', null, 'AI analysis & predictions'));
    const sourceLabel = ai.source === 'gemini-live' ? 'Live Google Gemini' : 'Offline Gemini mock';
    panel.appendChild(el('div', { class: 'notice' }, ai.note
      || 'Model-generated analysis and NON-GUARANTEED predictions for human decision-support only. Not authoritative retail facts; the numbers above remain the source of truth.'));
    panel.appendChild(el('p', { class: 'muted' }, `Source: ${sourceLabel} \u00b7 decision-support \u00b7 not a guaranteed forecast.`));

    if (ai.narrative) {
      panel.appendChild(el('div', { class: 'section-title' }, 'Analysis'));
      panel.appendChild(el('p', null, ai.narrative));
    }

    const predictions = Array.isArray(ai.predictions) ? ai.predictions : [];
    if (predictions.length) {
      panel.appendChild(el('div', { class: 'section-title' }, 'Predicted trends (non-guaranteed)'));
      const ul = el('ul', { class: 'ai-list' });
      predictions.forEach((p) => {
        const label = p && p.label ? p.label : String(p);
        const basis = p && p.basis ? ` \u2014 basis: ${p.basis}` : '';
        ul.appendChild(el('li', null, `${label}${basis}`));
      });
      panel.appendChild(ul);
    }

    const suggestions = Array.isArray(ai.suggestions) ? ai.suggestions : [];
    if (suggestions.length) {
      panel.appendChild(el('div', { class: 'section-title' }, 'Merchandising suggestions (decision-support)'));
      const ul = el('ul', { class: 'ai-list' });
      suggestions.forEach((s) => ul.appendChild(el('li', null, String(s))));
      panel.appendChild(ul);
    }

    root.appendChild(panel);
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
