'use strict';

/**
 * SCENEFIT AI - thin fetch wrapper for the backend JSON API.
 *
 * Base URL defaults to the same origin that served this page (so the whole
 * stack runs from `node backend/src/server.js`). It can be overridden by
 * setting `window.SCENEFIT_API_BASE` before this script loads, which is handy
 * when the frontend is deployed to Firebase Hosting and the API lives on a
 * separate Cloud Run origin.
 *
 * GOOGLE-ONLY / OFFLINE: this file makes NO external/CDN calls. Every request
 * targets the configured backend origin only.
 */

(function attachApi(global) {
  const BASE = (global.SCENEFIT_API_BASE || '').replace(/\/+$/, '');

  function url(path) {
    return `${BASE}${path}`;
  }

  async function request(method, path, body, headers) {
    const opts = {
      method,
      headers: Object.assign({ Accept: 'application/json' }, headers || {}),
    };
    if (body !== undefined && body !== null) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url(path), opts);
    let data = null;
    const text = await res.text();
    if (text) {
      try { data = JSON.parse(text); } catch (_e) { data = { raw: text }; }
    }
    if (!res.ok) {
      const err = new Error((data && data.detail) || (data && data.error) || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  const Api = {
    base: BASE,

    // --- health ---
    health: () => request('GET', '/healthz'),

    // --- conversation ---
    startSession: (userId) => request('POST', '/api/session', { userId }),
    sendMessage: (payload) => request('POST', '/api/message', payload),
    refine: (payload) => request('POST', '/api/refine', payload),

    // --- profile (F03) ---
    getProfile: (userId) => request('GET', `/api/profile?userId=${encodeURIComponent(userId)}`),
    putProfile: (userId, profile) => request('PUT', '/api/profile', { userId, profile }),

    // --- try-on (F05) ---
    tryOn: (payload) => request('POST', '/api/tryon', payload),

    // --- size guidance (F06) ---
    sizeGuidance: (payload) => request('POST', '/api/size-guidance', payload),

    // --- new arrivals ---
    newArrivals: (collectionId) => request('GET', `/api/new-arrivals${collectionId ? `?collectionId=${encodeURIComponent(collectionId)}` : ''}`),

    // --- store location (F09) ---
    locate: (sku) => request('GET', `/api/location/${encodeURIComponent(sku)}`),

    // --- staff-assist (F10) ---
    staffTask: (payload) => request('POST', '/api/staff-task', payload),
    getStaffTask: (id) => request('GET', `/api/staff-task/${encodeURIComponent(id)}`),

    // --- fitting-room queue (F11) ---
    requestQueue: (payload) => request('POST', '/api/queue', payload),
    getQueue: (id) => request('GET', `/api/queue/${encodeURIComponent(id)}`),
    cancelQueue: (id) => request('POST', `/api/queue/${encodeURIComponent(id)}/cancel`, {}),
    confirmQueue: (id, token) => request('POST', `/api/queue/${encodeURIComponent(id)}/confirm`, {}, authHeader(token)),
    advanceQueue: (id, targetState, token) => request('POST', `/api/queue/${encodeURIComponent(id)}/advance`, { targetState }, authHeader(token)),

    // --- cart & checkout handoff (F12) ---
    addToCart: (payload) => request('POST', '/api/cart', payload),
    getCart: (userId) => request('GET', `/api/cart?userId=${encodeURIComponent(userId || 'guest')}`),
    checkoutHandoff: (payload) => request('POST', '/api/checkout-handoff', payload),

    // --- dashboards (OPEN read-only VIEWS: no auth header sent) ---
    // Only aggregated, privacy-protected data is exposed. The operational
    // write actions (staff-task / queue lifecycle) remain role-gated and still
    // send an auth token via authHeader().
    retailDashboard: () => request('GET', '/api/dashboard/retail'),
    staffDashboard: () => request('GET', '/api/dashboard/staff'),
    merchandisingInsights: () => request('GET', '/api/dashboard/merchandising'),
  };

  function authHeader(token) {
    return token ? { 'x-auth-token': token } : {};
  }

  // Expose for classic scripts.
  global.ScenefitApi = Api;
})(window);
