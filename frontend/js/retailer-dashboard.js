'use strict';

/**
 * SCENEFIT AI - Retailer Intelligence Dashboard (F13) + Merchandising
 * Insights (F15). Consumes /api/dashboard/retail and
 * /api/dashboard/merchandising.
 *
 * These dashboard VIEWS are OPEN (no sign-in): they expose only aggregated,
 * privacy-protected data. F15 insights are labelled human decision-support,
 * never guaranteed forecasts or auto-reorder.
 *
 * Rendering is vanilla DOM only (no chart libraries, no CDN). KPI stat tiles,
 * CSS bar charts and an inline-SVG sparkline keep the whole thing offline.
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
    const list = Array.isArray(rows) ? rows : [];
    const max = Math.max(1, ...list.map((r) => Number(r[vk]) || 0));
    const chart = el('div', { class: 'barchart' });
    list.forEach((r) => {
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

  // KPI stat tile row.
  function kpiGrid(tiles) {
    const grid = el('div', { class: 'kpi-grid' });
    tiles.filter((t) => t.value != null).forEach((t) => grid.appendChild(el('div', { class: 'kpi-tile' }, [
      el('div', { class: 'kpi-value' }, String(t.value)),
      el('div', { class: 'kpi-label' }, t.label),
    ])));
    return grid;
  }

  // Inline-SVG sparkline / mini bar chart from a weekly series [{key,count}].
  function sparkline(rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return el('p', { class: 'muted' }, 'No trend data yet.');
    const max = Math.max(1, ...list.map((r) => Number(r.count) || 0));
    const w = 100;
    const h = 36;
    const gap = 4;
    const bw = (w - gap * (list.length - 1)) / list.length;
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('class', 'sparkline');
    svg.setAttribute('preserveAspectRatio', 'none');
    list.forEach((r, i) => {
      const val = Number(r.count) || 0;
      const bh = Math.max(1, (val / max) * (h - 2));
      const rect = document.createElementNS(svgNS, 'rect');
      rect.setAttribute('x', String(i * (bw + gap)));
      rect.setAttribute('y', String(h - bh));
      rect.setAttribute('width', String(bw));
      rect.setAttribute('height', String(bh));
      rect.setAttribute('rx', '1');
      rect.setAttribute('class', 'spark-bar');
      const title = document.createElementNS(svgNS, 'title');
      title.textContent = `${r.key}: ${val}`;
      rect.appendChild(title);
      svg.appendChild(rect);
    });
    const wrap = el('div', { class: 'sparkwrap' });
    wrap.appendChild(svg);
    const labels = el('div', { class: 'spark-labels' });
    list.forEach((r) => labels.appendChild(el('span', null, String(r.key).slice(5))));
    wrap.appendChild(labels);
    return wrap;
  }

  async function load() {
    setStatus('Loading retailer intelligence...');
    $('#kpis').innerHTML = '';
    $('#trend').innerHTML = '';
    $('#retail').innerHTML = '';
    $('#ai').innerHTML = '';
    $('#merch').innerHTML = '';
    try {
      const [retail, merch] = await Promise.all([
        Api.retailDashboard(),
        Api.merchandisingInsights(),
      ]);
      $('#authStatus').textContent = '';
      renderKpis(retail);
      renderTrend(retail);
      renderRetail(retail);
      // AI analysis / predictions panel - distinct from the hard numbers. Reads
      // from retail.aiInsights (preferred) or merch.aiAnalysis as a fallback.
      renderAiInsights(retail.aiInsights || (merch && merch.aiAnalysis) || null);
      renderMerch(merch);
      setStatus('');
    } catch (e) {
      setStatus('', false);
      $('#authStatus').textContent = `Failed to load: ${e.message}`;
    }
  }

  function renderKpis(data) {
    const k = data.kpis || {};
    const root = $('#kpis');
    const tiles = [
      { label: 'Total events (6 wks)', value: k.totalEvents },
      { label: 'Recommendations shown', value: k.recommendationsShown },
      { label: 'Saved looks', value: k.savedLooks },
      { label: 'Try-on events', value: k.tryOnEvents },
      { label: 'Checkout handoffs', value: k.checkoutHandoffs },
      { label: 'Avg basket (RM)', value: k.avgBasketRm },
      { label: 'Conversion rate', value: k.conversionRate != null ? `${Math.round(k.conversionRate * 100)}%` : null },
      { label: 'Total value (RM)', value: k.totalValueRm },
      { label: 'Unmet-demand signals', value: k.unmetDemandSignals },
    ];
    root.appendChild(el('div', { class: 'panel' }, [el('h3', null, 'Key metrics'), kpiGrid(tiles)]));
  }

  function renderTrend(data) {
    const t = (data.trends) || {};
    const root = $('#trend');
    root.appendChild(sectionPanel('Weekly trend', [
      el('p', { class: 'muted' }, 'Event volume per week (all signals) and demand signals per week.'),
      el('div', { class: 'trend-grid' }, [
        el('div', null, [el('div', { class: 'section-title' }, 'All events / week'), sparkline(t.eventsByWeek)]),
        el('div', null, [el('div', { class: 'section-title' }, 'Demand signals / week'), sparkline(t.demandByWeek)]),
      ]),
    ]));
  }

  function renderRetail(data) {
    const root = $('#retail');
    root.appendChild(el('div', { class: 'notice' }, (data.privacy && data.privacy.note)
      || 'Aggregated, privacy-protected data with retention/access controls.'));

    const s = data.sections || {};
    const intent = s.shoppingIntent || {};
    const demand = s.productDemand || {};
    const unmet = s.unmetDemand || {};
    const inStore = s.inStoreExperience || {};
    const commercial = s.commercialPerformance || {};

    // 1. Shopping Intent
    root.appendChild(sectionPanel('1 \u00b7 ' + (intent.title || 'Shopping Intent'), [
      el('p', { class: 'muted' }, 'Popular occasions, entry points and budget bands.'),
      el('div', { class: 'section-title' }, 'Popular occasions'),
      barChart(intent.popularOccasions || []),
      el('div', { class: 'section-title' }, 'Entry point'),
      barChart(intent.byEntryPoint || []),
      el('div', { class: 'section-title' }, 'Budget band'),
      barChart(intent.byBudgetBand || []),
    ]));
    // 2. Product Demand
    root.appendChild(sectionPanel('2 \u00b7 ' + (demand.title || 'Product Demand'), [
      el('p', { class: 'muted' }, 'Most requested styles and colours.'),
      el('div', { class: 'section-title' }, 'Styles'),
      barChart(demand.mostRequestedStyles || []),
      el('div', { class: 'section-title' }, 'Colours'),
      barChart(demand.mostRequestedColours || []),
    ]));
    // 3. Unmet Demand
    root.appendChild(sectionPanel('3 \u00b7 ' + (unmet.title || 'Unmet Demand'), [
      el('p', { class: 'muted' }, 'Reasons requests could not be fulfilled, plus specific missing sizes.'),
      el('div', { class: 'section-title' }, 'Reasons'),
      table(unmet.reasons || [], [{ key: 'key', label: 'Reason' }, { key: 'count', label: 'Count' }]),
      el('div', { class: 'section-title' }, 'Requested but unavailable sizes'),
      table(unmet.requestedButUnavailableSizes || [], [{ key: 'key', label: 'SKU / size' }, { key: 'count', label: 'Count' }]),
    ]));
    // 4. In-Store Experience
    root.appendChild(sectionPanel('4 \u00b7 ' + (inStore.title || 'In-Store Experience'), [
      el('p', { class: 'muted' }, 'Activity by zone and the in-store funnel.'),
      el('div', { class: 'section-title' }, 'Activity by zone'),
      barChart(inStore.activityByZone || []),
      el('div', { class: 'section-title' }, 'Funnel: lookups \u2192 assist \u2192 queue \u2192 completed'),
      barChart(inStore.funnel || []),
    ]));
    // 5. Commercial Performance
    const ck = commercial.kpis || {};
    root.appendChild(sectionPanel('5 \u00b7 ' + (commercial.title || 'Commercial Performance'), [
      el('p', { class: 'muted' }, 'Engagement, baskets and checkout handoffs.'),
      kpiGrid([
        { label: 'Add to cart', value: ck.addToCart },
        { label: 'Checkout handoffs', value: ck.checkoutHandoffs },
        { label: 'Avg basket (RM)', value: ck.avgBasketRm },
        { label: 'Conversion', value: ck.conversionRate != null ? `${Math.round(ck.conversionRate * 100)}%` : null },
        { label: 'Total value (RM)', value: ck.totalValueRm },
      ]),
      table(commercial.checkoutHandoffs || [], [
        { key: 'metric', label: 'Metric' }, { key: 'count', label: 'Count' }, { key: 'totalValueRm', label: 'Value (RM)' },
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
    panel.appendChild(el('h3', null, 'Merchandising & Inventory Insights (F15)'));
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
  // Open dashboard: auto-load on page open, no sign-in required.
  load();
})();
