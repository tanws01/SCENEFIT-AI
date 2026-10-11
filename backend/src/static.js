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

/**
 * Deterministic inline-SVG scene backgrounds for the Shop page. Each scene is a
 * purely illustrative, offline vector drawing built from the brand palette
 * (#6b4de6 / #4e34b8 accents) - no files on disk, no network. An unknown or
 * missing sceneId falls back to the neutral 'studio' scene so the UI's
 * background is never a 404.
 *
 * @param {string} sceneId one of: beach, resort, dinner, wedding, urban, studio
 * @returns {string} an SVG document string
 */
function sceneSvg(sceneId) {
  const id = String(sceneId || '').toLowerCase();
  const builder = SCENE_BUILDERS[id] || SCENE_BUILDERS.studio;
  return builder();
}

/** Shared SVG scaffold so every scene is a valid standalone document. */
function sceneDoc(label, inner) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800" preserveAspectRatio="xMidYMid slice" role="img" aria-label="${label}">
${inner}
</svg>`;
}

const SCENE_BUILDERS = Object.freeze({
  beach() {
    return sceneDoc('Beach / seaside scene', `  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#6b4de6"/>
      <stop offset="0.5" stop-color="#d98a3b"/>
      <stop offset="1" stop-color="#f6d9a8"/>
    </linearGradient>
    <linearGradient id="sea" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#4e34b8"/>
      <stop offset="1" stop-color="#2b6ea8"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="800" fill="url(#sky)"/>
  <circle cx="600" cy="470" r="120" fill="#ffe8b8" opacity="0.9"/>
  <rect y="500" width="1200" height="180" fill="url(#sea)"/>
  <rect y="660" width="1200" height="140" fill="#e8cf9c"/>
  <path d="M0 660 Q 300 630 600 660 T 1200 660 L 1200 700 L 0 700 Z" fill="#f0dcae" opacity="0.8"/>`);
  },
  resort() {
    return sceneDoc('Resort getaway scene', `  <defs>
    <linearGradient id="rsky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#6b4de6"/>
      <stop offset="1" stop-color="#9fd3e8"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="800" fill="url(#rsky)"/>
  <rect y="560" width="1200" height="240" fill="#1f8a52" opacity="0.85"/>
  <rect x="520" y="420" width="160" height="200" rx="10" fill="#ffffff" opacity="0.92"/>
  <rect x="300" y="600" width="600" height="90" rx="18" fill="#4e34b8" opacity="0.65"/>
  <circle cx="980" cy="200" r="80" fill="#ffe8b8" opacity="0.9"/>`);
  },
  dinner() {
    return sceneDoc('Evening dinner scene', `  <defs>
    <radialGradient id="glow" cx="0.5" cy="0.35" r="0.8">
      <stop offset="0" stop-color="#6b4de6"/>
      <stop offset="1" stop-color="#1c1b22"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="800" fill="url(#glow)"/>
  <circle cx="300" cy="220" r="10" fill="#f6d9a8" opacity="0.85"/>
  <circle cx="520" cy="160" r="8" fill="#f6d9a8" opacity="0.7"/>
  <circle cx="880" cy="240" r="12" fill="#f6d9a8" opacity="0.8"/>
  <rect x="420" y="560" width="360" height="30" rx="15" fill="#4e34b8" opacity="0.7"/>
  <rect x="560" y="470" width="80" height="110" rx="8" fill="#d98a3b" opacity="0.8"/>`);
  },
  wedding() {
    return sceneDoc('Wedding / reception scene', `  <defs>
    <linearGradient id="wsky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f3eefc"/>
      <stop offset="1" stop-color="#6b4de6"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="800" fill="url(#wsky)"/>
  <path d="M460 620 Q 460 360 600 360 Q 740 360 740 620 Z" fill="#ffffff" opacity="0.9"/>
  <path d="M460 620 Q 460 360 600 360 Q 740 360 740 620 Z" fill="none" stroke="#4e34b8" stroke-width="4" opacity="0.6"/>
  <circle cx="600" cy="300" r="30" fill="#d98a3b" opacity="0.85"/>
  <rect x="300" y="640" width="600" height="80" rx="20" fill="#4e34b8" opacity="0.5"/>`);
  },
  urban() {
    return sceneDoc('Urban / work scene', `  <defs>
    <linearGradient id="usky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#4e34b8"/>
      <stop offset="1" stop-color="#6b4de6"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="800" fill="url(#usky)"/>
  <rect x="120" y="340" width="120" height="460" fill="#1c1b22" opacity="0.8"/>
  <rect x="280" y="260" width="140" height="540" fill="#1c1b22" opacity="0.85"/>
  <rect x="460" y="400" width="110" height="400" fill="#1c1b22" opacity="0.75"/>
  <rect x="620" y="220" width="150" height="580" fill="#1c1b22" opacity="0.9"/>
  <rect x="820" y="360" width="130" height="440" fill="#1c1b22" opacity="0.8"/>
  <rect x="990" y="300" width="120" height="500" fill="#1c1b22" opacity="0.85"/>
  <g fill="#d98a3b" opacity="0.85">
    <rect x="310" y="300" width="20" height="26"/><rect x="360" y="300" width="20" height="26"/>
    <rect x="660" y="260" width="20" height="26"/><rect x="710" y="260" width="20" height="26"/>
  </g>`);
  },
  studio() {
    return sceneDoc('Studio backdrop', `  <defs>
    <linearGradient id="studio" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6b4de6"/>
      <stop offset="1" stop-color="#4e34b8"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="800" fill="url(#studio)"/>
  <circle cx="600" cy="360" r="260" fill="#ffffff" opacity="0.08"/>
  <circle cx="600" cy="360" r="170" fill="#ffffff" opacity="0.06"/>
  <rect y="620" width="1200" height="180" fill="#1c1b22" opacity="0.18"/>`);
  },
});

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
  const scene = pathname.match(/^\/assets\/scenes\/([^/]+)\.svg$/);
  if (scene) {
    const sceneId = decodeURIComponent(scene[1]);
    // Unknown ids fall back to the studio scene inside sceneSvg(); never 404.
    send(res, 200, CONTENT_TYPES['.svg'], sceneSvg(sceneId));
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

module.exports = { serveStatic, productSvg, sceneSvg, FRONTEND_DIR, CONTENT_TYPES };
