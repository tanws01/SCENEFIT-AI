'use strict';

/**
 * SCENEFIT AI backend HTTP server.
 *
 * Boots the Google-service adapters (deterministic offline mock mode by
 * default) and the deterministic application services, then exposes the
 * customer shopping-journey routes.
 *
 * BOUNDARY PRINCIPLE: Gemini (via adapters) only interprets language and
 * suggests outfit concepts. Every retail fact (SKU validity, price, stock,
 * size availability, budget compliance) is resolved and validated by the
 * deterministic services in backend/src/services/*.
 *
 * Zero external dependencies - Node standard library only.
 * Run with: env -u NODE_OPTIONS node backend/src/server.js
 */

const http = require('node:http');
const { loadConfig } = require('./config');
const { createAdapters } = require('./adapters');
const { createCatalogue } = require('./services/catalogue');
const { createOutfitEngine } = require('./services/outfitEngine');
const { createStyleProfile } = require('./services/styleProfile');
const { createWardrobe } = require('./services/wardrobe');
const { createSizeGuidance } = require('./services/sizeGuidance');
const { createTryOn } = require('./services/tryOn');
const { createConversation } = require('./services/conversation');
const { createStoreNavigation } = require('./services/storeNavigation');
const { createStaffTasks } = require('./services/staffTasks');
const { createFittingRoomQueue } = require('./services/fittingRoomQueue');
const { createCart } = require('./services/cart');
const { createAnalytics } = require('./services/analytics');

/**
 * Build the full service graph from adapters. Exposed for tests so they can
 * drive the exact same wiring the server uses.
 * @param {object} adapters
 */
function createServices(adapters) {
  const catalogue = createCatalogue({ firestore: adapters.firestore });
  const outfitEngine = createOutfitEngine({ catalogue, gemini: adapters.gemini, storage: adapters.storage });
  const styleProfile = createStyleProfile({ firestore: adapters.firestore });
  const wardrobe = createWardrobe({ firestore: adapters.firestore, catalogue });
  const sizeGuidance = createSizeGuidance({ firestore: adapters.firestore, catalogue });
  const tryOn = createTryOn({ vertexImage: adapters.vertexImage, catalogue });
  const conversation = createConversation({
    gemini: adapters.gemini,
    speech: adapters.speech,
    firestore: adapters.firestore,
  });

  // In-store experience + omnichannel + intelligence (FEAT-003).
  // The store/branch record is static seeded retail data.
  // eslint-disable-next-line global-require
  const store = require('../data/store.json');
  const storeNavigation = createStoreNavigation({ firestore: adapters.firestore, catalogue });
  const staffTasks = createStaffTasks({ firestore: adapters.firestore, catalogue, storeNavigation });
  const fittingRoomQueue = createFittingRoomQueue({ firestore: adapters.firestore, store });
  const cart = createCart({ firestore: adapters.firestore, catalogue });
  const analytics = createAnalytics({ bigquery: adapters.bigquery, staffTasks, store });

  return {
    catalogue, outfitEngine, styleProfile, wardrobe, sizeGuidance, tryOn, conversation,
    storeNavigation, staffTasks, fittingRoomQueue, cart, analytics, store,
  };
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (_e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

/**
 * Build the request handler. Takes the service graph so it can be unit-tested
 * without binding a port.
 * @param {object} ctx { config, adapters, services }
 */
function createRequestHandler(ctx) {
  const { config, services, adapters } = ctx;

  /**
   * Gate staff / retailer routes behind a Firebase Auth role check. Verifies
   * the bearer token via the firebaseAuth adapter (mock returns {uid, role})
   * and ensures the role is in the allowed set. Returns the decoded auth on
   * success, or null after sending a 401/403 response.
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @param {string[]} allowedRoles
   */
  async function requireRole(req, res, allowedRoles) {
    const token = req.headers.authorization || req.headers['x-auth-token'] || '';
    if (!token) {
      sendJson(res, 401, { error: 'unauthenticated', detail: 'missing auth token' });
      return null;
    }
    let decoded;
    try {
      decoded = await adapters.auth.verifyToken(token);
    } catch (_e) {
      sendJson(res, 401, { error: 'unauthenticated', detail: 'invalid auth token' });
      return null;
    }
    if (!allowedRoles.includes(decoded.role)) {
      sendJson(res, 403, { error: 'forbidden', detail: `role "${decoded.role}" not permitted` });
      return null;
    }
    return decoded;
  }

  return async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname } = url;
    const method = req.method;

    try {
      // --- health ---
      if (method === 'GET' && (pathname === '/healthz' || pathname === '/health')) {
        return sendJson(res, 200, {
          status: 'ok',
          service: 'scenefit-ai',
          cloud: 'google-cloud',
          currency: config.currency,
          modes: config.modes,
        });
      }

      // --- conversation session ---
      if (method === 'POST' && pathname === '/api/session') {
        const body = await readBody(req);
        const session = await services.conversation.startSession({ userId: body.userId });
        return sendJson(res, 201, { sessionId: session.id, userId: session.userId });
      }

      // --- message: text/voice -> intent + 3 outfits (or insufficient) ---
      if (method === 'POST' && pathname === '/api/message') {
        const body = await readBody(req);
        let sessionId = body.sessionId;
        if (!sessionId) {
          const s = await services.conversation.startSession({ userId: body.userId });
          sessionId = s.id;
        }
        const profile = body.userId ? await services.styleProfile.get(body.userId) : (body.profile || {});
        const result = await services.conversation.handleMessage(sessionId, {
          text: body.text,
          voiceRef: body.voiceRef,
          profile,
        });
        const recommendation = await services.outfitEngine.recommend(result.intent, { profile });
        return sendJson(res, 200, {
          sessionId,
          intent: result.intent,
          inputMode: result.inputMode,
          transcript: result.transcript,
          followUp: result.followUp,
          recommendation,
        });
      }

      // --- refine: merge delta into prior intent, re-recommend ---
      if (method === 'POST' && pathname === '/api/refine') {
        const body = await readBody(req);
        if (!body.sessionId) return sendJson(res, 400, { error: 'sessionId required' });
        const profile = body.userId ? await services.styleProfile.get(body.userId) : (body.profile || {});
        const result = await services.conversation.handleRefine(body.sessionId, {
          text: body.text,
          voiceRef: body.voiceRef,
          profile,
        });
        const recommendation = await services.outfitEngine.recommend(result.intent, { profile });
        return sendJson(res, 200, {
          sessionId: body.sessionId,
          intent: result.intent,
          keptRoles: result.keptRoles,
          intentSwitched: result.intentSwitched,
          followUp: result.followUp,
          recommendation,
        });
      }

      // --- profile get/put ---
      if (pathname === '/api/profile') {
        if (method === 'GET') {
          const userId = url.searchParams.get('userId');
          if (!userId) return sendJson(res, 400, { error: 'userId required' });
          return sendJson(res, 200, await services.styleProfile.get(userId));
        }
        if (method === 'PUT') {
          const body = await readBody(req);
          if (!body.userId) return sendJson(res, 400, { error: 'userId required' });
          const updated = await services.styleProfile.update(body.userId, body.profile || body);
          return sendJson(res, 200, updated);
        }
      }

      // --- virtual try-on ---
      if (method === 'POST' && pathname === '/api/tryon') {
        const body = await readBody(req);
        if (Array.isArray(body.skus) && body.skus.length > 1) {
          return sendJson(res, 200, await services.tryOn.previewOutfit({ skus: body.skus, userPhotoRef: body.userPhotoRef }));
        }
        const sku = body.sku || (Array.isArray(body.skus) ? body.skus[0] : null);
        return sendJson(res, 200, await services.tryOn.previewGarment({ sku, userPhotoRef: body.userPhotoRef }));
      }

      // --- size guidance ---
      if (method === 'POST' && pathname === '/api/size-guidance') {
        const body = await readBody(req);
        return sendJson(res, 200, await services.sizeGuidance.suggest(body));
      }

      // --- new arrivals ---
      if (method === 'GET' && pathname === '/api/new-arrivals') {
        const collectionId = url.searchParams.get('collectionId') || undefined;
        const products = await services.catalogue.listNewArrivals({ collectionId });
        return sendJson(res, 200, { count: products.length, products });
      }

      // --- F09 exact in-store rack location & navigation ---
      if (method === 'GET' && pathname.startsWith('/api/location/')) {
        const sku = decodeURIComponent(pathname.slice('/api/location/'.length));
        if (!sku) return sendJson(res, 400, { error: 'sku required' });
        const result = await services.storeNavigation.locate(sku);
        return sendJson(res, result.found ? 200 : 404, result);
      }

      // --- F10 staff-assisted product collection ---
      if (method === 'POST' && pathname === '/api/staff-task') {
        const body = await readBody(req);
        const task = await services.staffTasks.submitTask({
          userId: body.userId,
          storeId: body.storeId || services.store.id,
          garments: body.garments || body.items || [],
        });
        return sendJson(res, 201, task);
      }
      if (method === 'GET' && /^\/api\/staff-task\/[^/]+$/.test(pathname)) {
        const id = decodeURIComponent(pathname.split('/').pop());
        const task = await services.staffTasks.get(id);
        if (!task) return sendJson(res, 404, { error: 'not_found', id });
        return sendJson(res, 200, task);
      }
      {
        const m = pathname.match(/^\/api\/staff-task\/([^/]+)\/(accept|reject|prepare)$/);
        if (method === 'POST' && m) {
          const auth = await requireRole(req, res, ['associate', 'ops', 'admin']);
          if (!auth) return undefined;
          const id = decodeURIComponent(m[1]);
          const action = m[2];
          const body = await readBody(req);
          try {
            let task;
            if (action === 'accept') task = await services.staffTasks.accept(id, { staffId: auth.uid, ...body });
            else if (action === 'reject') task = await services.staffTasks.reject(id, body);
            else task = await services.staffTasks.prepare(id, body);
            return sendJson(res, 200, task);
          } catch (e) {
            const code = e.code === 'NOT_FOUND' ? 404 : 409;
            return sendJson(res, code, { error: e.code || 'task_error', detail: e.message });
          }
        }
      }

      // --- F11 smart fitting-room queue ---
      if (method === 'POST' && pathname === '/api/queue') {
        const body = await readBody(req);
        const result = await services.fittingRoomQueue.requestQueue({
          branch: services.store,
          userId: body.userId,
          items: body.items || body.garments || [],
        });
        return sendJson(res, result.supported ? 201 : 409, result);
      }
      if (method === 'GET' && /^\/api\/queue\/[^/]+$/.test(pathname)) {
        const id = decodeURIComponent(pathname.split('/').pop());
        const ticket = await services.fittingRoomQueue.get(id);
        if (!ticket) return sendJson(res, 404, { error: 'not_found', id });
        return sendJson(res, 200, ticket);
      }
      {
        const m = pathname.match(/^\/api\/queue\/([^/]+)\/(confirm|advance|cancel)$/);
        if (method === 'POST' && m) {
          const id = decodeURIComponent(m[1]);
          const action = m[2];
          const body = await readBody(req);
          try {
            let ticket;
            if (action === 'confirm') {
              // Store/operational confirmation is a staff-gated action.
              const auth = await requireRole(req, res, ['associate', 'ops', 'admin']);
              if (!auth) return undefined;
              ticket = await services.fittingRoomQueue.confirm(id, body);
            } else if (action === 'cancel') {
              // Customer stays in control - no staff role required to cancel.
              ticket = await services.fittingRoomQueue.cancel(id, body);
            } else {
              // advance is a staff-gated operational action.
              const auth = await requireRole(req, res, ['associate', 'ops', 'admin']);
              if (!auth) return undefined;
              ticket = await services.fittingRoomQueue.advance(id, body.targetState, body);
            }
            return sendJson(res, 200, ticket);
          } catch (e) {
            const code = e.code === 'NOT_FOUND' ? 404 : 409;
            return sendJson(res, code, { error: e.code || 'queue_error', detail: e.message });
          }
        }
      }

      // --- F12 cart & checkout handoff ---
      if (pathname === '/api/cart') {
        if (method === 'POST') {
          const body = await readBody(req);
          const userId = body.userId || 'guest';
          if (body.outfit) {
            const cart = await services.cart.saveOutfit(userId, body.outfit);
            return sendJson(res, 200, cart);
          }
          const cart = await services.cart.addItem(userId, body.item || body);
          return sendJson(res, 200, cart);
        }
        if (method === 'GET') {
          const userId = url.searchParams.get('userId') || 'guest';
          const cart = await services.cart.getCart(userId);
          const comparison = await services.cart.compareLooks(userId);
          return sendJson(res, 200, { cart, comparison });
        }
      }
      if (method === 'POST' && pathname === '/api/checkout-handoff') {
        const body = await readBody(req);
        const userId = body.userId || 'guest';
        const result = await services.cart.checkoutHandoff(userId, {
          mode: body.mode,
          storeId: body.storeId || services.store.id,
        });
        return sendJson(res, 200, result);
      }

      // --- F13 / F14 / F15 dashboards (staff/retailer gated) ---
      if (method === 'GET' && pathname === '/api/dashboard/retail') {
        const auth = await requireRole(req, res, ['merchandiser', 'ops', 'admin']);
        if (!auth) return undefined;
        return sendJson(res, 200, await services.analytics.retailDashboard());
      }
      if (method === 'GET' && pathname === '/api/dashboard/staff') {
        const auth = await requireRole(req, res, ['associate', 'ops', 'admin']);
        if (!auth) return undefined;
        return sendJson(res, 200, await services.analytics.staffDashboard());
      }
      if (method === 'GET' && pathname === '/api/dashboard/merchandising') {
        const auth = await requireRole(req, res, ['merchandiser', 'ops', 'admin']);
        if (!auth) return undefined;
        return sendJson(res, 200, await services.analytics.merchandisingInsights());
      }

      return sendJson(res, 404, { error: 'not_found', path: pathname });
    } catch (err) {
      const status = /invalid JSON|too large/i.test(err.message) ? 400 : 500;
      return sendJson(res, status, { error: 'request_failed', detail: err.message });
    }
  };
}

const config = loadConfig(process.env);
const adapters = createAdapters(config);
const services = createServices(adapters);
const server = http.createServer(createRequestHandler({ config, adapters, services }));

/* istanbul ignore next */
if (require.main === module) {
  server.listen(config.port, '0.0.0.0', () => {
    // eslint-disable-next-line no-console
    console.log(`SCENEFIT AI backend listening on 0.0.0.0:${config.port} (modes: ${JSON.stringify(config.modes)})`);
  });
}

module.exports = { server, config, adapters, services, createServices, createRequestHandler };
