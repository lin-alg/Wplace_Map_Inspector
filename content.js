// content.js - page-side scanner implementation
// 说明：background 会发送 { type: 'runScan', item, options }
// 本脚本需执行页面上的扫描动作并把扫描文本返回：sendResponse({ ok:true, text: '...' })
// 另外保留 grabCoords 接口以供 Pick Start/End 使用

console.log('WPI content.js loaded (scanner)');

function parseBmH(text) {
  if (!text) return null;
  const re = /Tl\s*X\s*[:：]\s*([-\d.]+)[,\)\s]+Tl\s*Y\s*[:：]\s*([-\d.]+)[,\)\s]+Px\s*X\s*[:：]\s*([-\d.]+)[,\)\s]+Px\s*Y\s*[:：]\s*([-\d.]+)/i;
  const m = re.exec(text);
  if (!m) return null;
  return { tlX: Number(m[1]), tlY: Number(m[2]), pxX: Number(m[3]), pxY: Number(m[4]) };
}

const COORD_EVENT_NAME = 'wpi-coords';
let lastCoordSnapshot = null;

function captureCoord(detail) {
  if (!detail) return;
  const tlX = Number(detail.tlX ?? detail.tileX ?? detail.tx);
  const tlY = Number(detail.tlY ?? detail.tileY ?? detail.ty);
  const pxX = Number(detail.pxX ?? detail.pixelX ?? detail.px);
  const pxY = Number(detail.pxY ?? detail.pixelY ?? detail.py);
  if ([tlX, tlY, pxX, pxY].every(n => Number.isFinite(n))) {
    lastCoordSnapshot = { tlX, tlY, pxX, pxY, source: detail.source || 'fetch-hook', ts: detail.ts || Date.now() };
  }
}

function initCoordEventTap() {
  if (window.__WPI_COORD_EVENT_BOUND__) return;
  window.__WPI_COORD_EVENT_BOUND__ = true;
  window.addEventListener(COORD_EVENT_NAME, (evt) => {
    try { captureCoord(evt.detail); } catch (e) { console.warn('WPI coord event error', e); }
  });
}

initCoordEventTap();
// Fetch tap now injected by page-hooks.js running in the MAIN world per manifest.

function extractCoordsFromPixelUrl(url) {
  if (!url || url.indexOf('/pixel/') === -1) return null;
  try {
    const cleanUrl = url.split('#')[0];
    const [pathPart, queryPart = ''] = cleanUrl.split('?');
    const segments = pathPart.split('/').filter(Boolean);
    if (segments.length < 2) return null;
    const tlX = Number(segments[segments.length - 2]);
    const tlY = Number(segments[segments.length - 1]);
    const params = new URLSearchParams(queryPart);
    const pxX = Number(params.get('x'));
    const pxY = Number(params.get('y'));
    if ([tlX, tlY, pxX, pxY].every(n => Number.isFinite(n))) {
      return { tlX, tlY, pxX, pxY };
    }
  } catch (err) {}
  return null;
}

function installPixelPerformanceTap() {
  if (!('PerformanceObserver' in window) || window.__WPI_PIXEL_PERF_TAP__) return;
  window.__WPI_PIXEL_PERF_TAP__ = true;
  const handleEntries = (entries) => {
    entries.forEach(entry => {
      if (!entry || !entry.name) return;
      const coords = extractCoordsFromPixelUrl(entry.name);
      if (!coords) return;
      captureCoord(coords);
      try { window.dispatchEvent(new CustomEvent(COORD_EVENT_NAME, { detail: Object.assign({ source: 'perf-resource', ts: Date.now() }, coords) })); }
      catch (err) { console.warn('WPI coord event dispatch failed', err); }
    });
  };
  try {
    const existing = performance.getEntriesByType('resource') || [];
    handleEntries(existing);
  } catch (err) {
    console.warn('WPI perf preload failed', err);
  }
  try {
    const observer = new PerformanceObserver(list => handleEntries(list.getEntries()));
    observer.observe({ entryTypes: ['resource'] });
  } catch (err) {
    console.warn('WPI perf observer failed', err);
  }
}

installPixelPerformanceTap();

function parseBmDisplaySpan() {
  const el = document.getElementById('bm-display-coords');
  if (!el || !el.textContent) return null;
  return parseBmH(el.textContent);
}

function parseBmInputs() {
  const tx = document.getElementById('bm-input-tx');
  const ty = document.getElementById('bm-input-ty');
  const px = document.getElementById('bm-input-px');
  const py = document.getElementById('bm-input-py');
  if (!tx || !ty || !px || !py) return null;
  const tlX = Number(tx.value);
  const tlY = Number(ty.value);
  const pxX = Number(px.value);
  const pxY = Number(py.value);
  if ([tlX, tlY, pxX, pxY].every(n => Number.isFinite(n))) return { tlX, tlY, pxX, pxY, source: 'bm-inputs' };
  return null;
}

function getBestCoords() {
  const hud = (() => {
    try {
      const el = document.getElementById('bm-h');
      return parseBmH(el ? (el.innerText || el.textContent || '') : '');
    } catch (_) { return null; }
  })();
  if (hud) return hud;
  if (lastCoordSnapshot) return Object.assign({}, lastCoordSnapshot);
  const display = parseBmDisplaySpan();
  if (display) return display;
  const inputs = parseBmInputs();
  if (inputs) return inputs;
  return null;
}

/* grabCoords: existing interface for pick */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'grabCoords') {
    try {
      const coords = getBestCoords();
      if (!coords) {
        sendResponse({ ok: false, error: 'no-coords' });
        return;
      }
      sendResponse({ ok: true, coords });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
    return;
  }

  // runScan: perform the scanner action on the page using item params
  if (msg.type === 'runScan') {
    // Expected item shape: { id, tabId, start:{x,y,blockX,blockY}, end: {...}, meta: {...} }
    (async function handleScan() {
      try {
        const item = msg.item || {};
        // Implement your page-specific scanning logic here.
        // Example minimal scanner:
        // - if page exposes a function to perform scan, call it
        // - otherwise try to collect text from certain DOM selectors between coordinates
        //
        // This example tries three strategies in order and returns the first usable result:
        // 1) If window.__wplace_scan is defined, call it (synchronous or async)
        // 2) If a specific element with id 'scan-output' exists, use its text
        // 3) Fallback: collect document.body.innerText (may be large)
        //
        // Replace this with your actual scan implementation.

        // strategy 1: page-provided scanner hook
        if (typeof window.__wplace_scan === 'function') {
          try {
            const maybe = window.__wplace_scan(item);
            const text = (maybe && maybe.then) ? await maybe : maybe;
            sendResponse({ ok: true, text: String(text || '') });
            return;
          } catch (e) {
            console.warn('content runScan: __wplace_scan failed', e);
          }
        }

        // strategy 2: specific DOM element
        const outEl = document.getElementById('scan-output');
        if (outEl) {
          const t = outEl.innerText || outEl.textContent || '';
          sendResponse({ ok: true, text: String(t) });
          return;
        }

        // strategy 3: fallback whole page text (last resort)
        const fallback = (document.body && (document.body.innerText || document.body.textContent)) || '';
        sendResponse({ ok: true, text: String(fallback) });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    // Indicate synchronous false is not needed because sendResponse is called within same tick or async but we used immediate sendResponse inside async closure; for safety return true if async:
    return true;
  }
});
