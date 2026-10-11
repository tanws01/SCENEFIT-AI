'use strict';

/**
 * Static file handler for the SCENEFIT AI frontend.
 *
 * Serves the vanilla HTML/CSS/JS app from the frontend/ directory so the whole
 * stack runs from a single `node backend/src/server.js` with zero external
 * dependencies and fully offline. The frontend also stays independently
 * deployable to Firebase Hosting (all paths are relative/root-absolute).
 *
 * It also synthesises deterministic placeholder product images as inline SVG
 * for /assets/products/<SKU>.png requests, so no binary assets or network
 * fetches are required. Content-types are set explicitly.
 *
 * SECURITY: paths are normalised and confined to the frontend root - directory
 * traversal (".." / absolute escapes) is rejected.
 */

const fs = require('node:fs');
const path = require('node:path');

const FRONTEND_DIR = path.join(__dirname, '..', '..', 'frontend');

const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
});

/** Deterministic colour per product category / SKU prefix. */
function colourForSku(sku) {
  const palette = {
    TOP: '#6b4de6', BOT: '#4e34b8', FTW: '#d98a3b', OUT: '#1f8a52', ACC: '#b4530f',
  };
  const prefix = String(sku || '').slice(0, 3).toUpperCase();
  return palette[prefix] || '#8a8597';
}

/**
 * Build a deterministic SVG placeholder "product image" for a SKU. Returns an
 * SVG string (served as image/svg+xml). This keeps the app fully offline with
 * no binary assets while still giving each product a distinct visual.
 * @param {string} sku
 */
function productSvg(sku) {
  const fill = colourForSku(sku);
  const label = String(sku || 'ITEM');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400" viewBox="0 0 300 400" role="img" aria-label="${label}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${fill}"/>
      <stop offset="1" stop-color="#1c1b22"/>
    </linearGradient>
  </defs>
  <rect width="300" height="400" fill="url(#g)"/>
  <rect x="24" y="24" width="252" height="352" fill="none" stroke="#ffffff" stroke-opacity="0.3" stroke-width="2" rx="12"/>
  <text x="150" y="40" text-anchor="middle" fill="#ffffff" font-family="system-ui, sans-serif" font-size="14" opacity="0.85">SCENEFIT AI</text>
  <text x="150" y="210" text-anchor="middle" fill="#ffffff" font-family="system-ui, sans-serif" font-size="22" font-weight="700">${label}</text>
  <text x="150" y="372" text-anchor="middle" fill="#ffffff" font-family="system-ui, sans-serif" font-size="12" opacity="0.75">illustrative product image</text>
</svg>`;
}

const FAVICON_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#6b4de6"/>
  <text x="32" y="42" text-anchor="middle" fill="#ffffff" font-family="system-ui, sans-serif" font-size="30" font-weight="800">SF</text>
</svg>`;

function send(res, status, type, body) {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

/**
 * Try to serve a static asset for the given pathname.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} pathname decoded URL pathname
 * @returns {boolean} true if the request was handled, false otherwise
 */
function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  // Synthesised assets (no files on disk).
  if (pathname === '/assets/favicon.svg') {
    send(res, 200, CONTENT_TYPES['.svg'], FAVICON_SVG);
    return true;
  }
  const prod = pathname.match(/^\/assets\/products\/([^/]+)\.png$/);
  if (prod) {
    const sku = decodeURIComponent(prod[1]);
    // Serve SVG bytes under the .png URL (content-type is authoritative here).
    send(res, 200, CONTENT_TYPES['.svg'], productSvg(sku));
    return true;
  }

  // Map "/" to the app shell.
  let rel = pathname === '/' ? '/index.html' : pathname;

  // Normalise and confine to the frontend directory (reject traversal).
  const safeRel = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '');
  const full = path.join(FRONTEND_DIR, safeRel);
  if (!full.startsWith(FRONTEND_DIR)) {
    return false; // escaped the root -> not handled here (fall through to 404)
  }

  let stat;
  try {
    stat = fs.statSync(full);
  } catch (_e) {
    return false;
  }
  if (!stat.isFile()) return false;

  const ext = path.extname(full).toLowerCase();
  const type = CONTENT_TYPES[ext] || 'application/octet-stream';
  const data = fs.readFileSync(full);
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': data.length,
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') { res.end(); return true; }
  res.end(data);
  return true;
}

module.exports = { serveStatic, productSvg, FRONTEND_DIR, CONTENT_TYPES };
