'use strict';

/**
 * SCENEFIT AI backend HTTP server (scaffold).
 *
 * This FEAT-001 scaffold boots the Google-service adapters (in deterministic
 * offline mock mode by default) and exposes a health endpoint. Later features
 * add the journey, outfit, size, navigation, queue, and dashboard routes.
 *
 * Zero external dependencies - Node standard library only.
 * Run with: env -u NODE_OPTIONS node backend/src/server.js
 */

const http = require('node:http');
const { loadConfig } = require('./config');
const { createAdapters } = require('./adapters');

const config = loadConfig(process.env);
const adapters = createAdapters(config);

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, {
      status: 'ok',
      service: 'scenefit-ai',
      cloud: 'google-cloud',
      currency: config.currency,
      modes: config.modes,
    });
    return;
  }

  sendJson(res, 404, { error: 'not_found', path: url.pathname });
});

/* istanbul ignore next */
if (require.main === module) {
  server.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`SCENEFIT AI backend listening on :${config.port} (modes: ${JSON.stringify(config.modes)})`);
  });
}

module.exports = { server, config, adapters };
