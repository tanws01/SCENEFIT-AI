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
  return { catalogue, outfitEngine, styleProfile, wardrobe, sizeGuidance, tryOn, conversation };
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
  const { config, services } = ctx;

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
