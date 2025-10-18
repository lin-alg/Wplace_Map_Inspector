// popup.js - Cross-browser compatible version (storage falls back to localStorage)
// Goal: Work on Chrome/Edge/Firefox. Prefer scripting.executeScript, fall back to tabs.executeScript, then messaging.

/* ---- API wrapper ---- */
const api = (function() {
  const hasBrowser = typeof browser !== 'undefined';
  const raw = hasBrowser ? browser : (typeof chrome !== 'undefined' ? chrome : null);

  function queryActiveTab() {
    return new Promise(resolve => {
      try {
        raw.tabs.query({ active: true, currentWindow: true }, tabs => {
          resolve((tabs && tabs[0]) || null);
        });
      } catch (e) { resolve(null); }
    });
  }

  function sendMessageToTab(tabId, msg) {
    return new Promise(resolve => {
      try {
        raw.tabs.sendMessage(tabId, msg, resp => {
          const err = raw.runtime && raw.runtime.lastError;
          if (err) resolve({ ok: false, error: err.message });
          else resolve({ ok: true, resp });
        });
      } catch (e) { resolve({ ok: false, error: String(e) }); }
    });
  }

  // Storage compatibility: use storage.local when available, otherwise localStorage
  async function storageGetCompat(key) {
    try {
      if (raw && raw.storage && raw.storage.local) {
        return await new Promise(resolve => {
          raw.storage.local.get([key], res => {
            const err = (raw.runtime && raw.runtime.lastError) || null;
            if (err) {
              try {
                const v = localStorage.getItem(key);
                resolve(v ? JSON.parse(v) : undefined);
              } catch (e) { resolve(undefined); }
              return;
            }
            resolve(res ? res[key] : undefined);
          });
        });
      }
    } catch (e) { /* fallthrough */ }

    try {
      const rawVal = localStorage.getItem(key);
      return rawVal ? JSON.parse(rawVal) : undefined;
    } catch (e) { return undefined; }
  }

  async function storageSetCompat(key, value) {
    try {
      if (raw && raw.storage && raw.storage.local) {
        return await new Promise(resolve => {
          const obj = {}; obj[key] = value;
          raw.storage.local.set(obj, () => {
            const err = (raw.runtime && raw.runtime.lastError) || null;
            if (err) {
              try { localStorage.setItem(key, JSON.stringify(value)); resolve({ ok: true, fallback: 'localStorage' }); }
              catch (e) { resolve({ ok: false, error: String(err) }); }
              return;
            }
            resolve({ ok: true });
          });
        });
      }
    } catch (e) { /* fallthrough */ }

    try {
      localStorage.setItem(key, JSON.stringify(value));
      return { ok: true, fallback: 'localStorage' };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // executeScript wrapper: try multiple APIs for wider compatibility
  async function execScript(tabId, func, args) {
    args = args || [];
    try {
      if (raw.scripting && raw.scripting.executeScript) {
        const res = await new Promise((resolve, reject) => {
          raw.scripting.executeScript({ target: { tabId }, func, args }, results => {
            const err = raw.runtime && raw.runtime.lastError;
            if (err) return reject(err);
            resolve(results);
          });
        });
        return { ok: true, mode: 'scripting', res };
      }
    } catch (e) { /* try next method */ }

    try {
      if (raw.tabs && raw.tabs.executeScript) {
        const res = await new Promise((resolve, reject) => {
          try {
            raw.tabs.executeScript(tabId, { func, args }, results => {
              const err = raw.runtime && raw.runtime.lastError;
              if (err) return reject(err);
              resolve(results);
            });
          } catch (err2) {
            const code = '(' + func.toString() + ').apply(null, ' + JSON.stringify(args || []) + ');';
            raw.tabs.executeScript(tabId, { code }, results => {
              const err = raw.runtime && raw.runtime.lastError;
              if (err) return reject(err);
              resolve(results);
            });
          }
        });
        return { ok: true, mode: 'tabs-exec', res };
      }
    } catch (e) { /* no exec API available */ }

    return { ok: false, error: 'no-exec-api' };
  }

  return {
    raw,
    queryActiveTab,
    sendMessageToTab,
    storageGet: storageGetCompat,
    storageSet: storageSetCompat,
    execScript
  };
})();

/* ---- UI bindings & helpers ---- */
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const clearBtn = document.getElementById('clearBtn');
const logEl = document.getElementById('log');

const inputs = {
  startBlockX: document.getElementById('startBlockX'),
  startBlockY: document.getElementById('startBlockY'),
  startX: document.getElementById('startX'),
  startY: document.getElementById('startY'),
  endBlockX: document.getElementById('endBlockX'),
  endBlockY: document.getElementById('endBlockY'),
  endX: document.getElementById('endX'),
  endY: document.getElementById('endY'),
  stepX: document.getElementById('stepX'),
  stepY: document.getElementById('stepY'),
  CONCURRENCY: document.getElementById('CONCURRENCY'),
  MAX_RPS: document.getElementById('MAX_RPS'),
  BASE_TEMPLATE: document.getElementById('BASE_TEMPLATE')
};

const SETTINGS_KEY = 'pxf_settings';
let saveTimer = null;

function log(type, text, extra) {
  try {
    if (logEl) {
      const p = document.createElement('div');
      p.className = type || 'info';
      const time = new Date().toLocaleTimeString();
      p.textContent = `[${time}] ${text}` + (extra ? ` ${JSON.stringify(extra)}` : '');
      logEl.appendChild(p);
      logEl.scrollTop = logEl.scrollHeight;
    }
  } catch (e) {}
  if (type === 'error') console.error(text, extra || '');
  else if (type === 'warn') console.warn(text, extra || '');
  else console.log(text, extra || '');
}

/* Settings helpers */
function collectSettingsFromUI() {
  return {
    startBlockX: Number(inputs.startBlockX.value || 0),
    startBlockY: Number(inputs.startBlockY.value || 0),
    startX: Number(inputs.startX.value || 0),
    startY: Number(inputs.startY.value || 0),
    endBlockX: Number(inputs.endBlockX.value || 0),
    endBlockY: Number(inputs.endBlockY.value || 0),
    endX: Number(inputs.endX.value || 0),
    endY: Number(inputs.endY.value || 0),
    stepX: Number(inputs.stepX.value || 1),
    stepY: Number(inputs.stepY.value || 1),
    CONCURRENCY: Number(inputs.CONCURRENCY.value || 4),
    MAX_RPS: Number(inputs.MAX_RPS.value || 6),
    BASE_TEMPLATE: (inputs.BASE_TEMPLATE.value || '').trim()
  };
}

function applySettingsToUI(cfg) {
  if (!cfg) return;
  Object.keys(inputs).forEach(k => {
    if (cfg[k] != null) inputs[k].value = String(cfg[k]);
  });
}

function scheduleSaveSettings() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSettings, 300);
}

async function saveSettings() {
  const cfg = collectSettingsFromUI();
  const r = await api.storageSet(SETTINGS_KEY, cfg);
  if (r && r.ok) log('info', 'Settings saved' + (r.fallback ? ` (fallback:${r.fallback})` : ''));
  else log('warn', 'Failed to save settings', r && r.error);
}

async function loadSettings() {
  const cfg = await api.storageGet(SETTINGS_KEY);
  if (cfg) { applySettingsToUI(cfg); log('info', 'Loaded saved settings'); }
}

/* Bind inputs */
Object.values(inputs).forEach(el => { if (!el) return; el.addEventListener('input', scheduleSaveSettings); });
clearBtn.addEventListener('click', () => { if (logEl) logEl.innerHTML = ''; });

/* Stop (best-effort): tell content script to stop if it exists */
stopBtn.addEventListener('click', async () => {
  stopBtn.disabled = true;
  const tab = await api.queryActiveTab();
  if (!tab || !tab.id) { log('error', 'Active tab not found'); stopBtn.disabled = false; return; }
  const res = await api.sendMessageToTab(tab.id, { type: 'stop-script' });
  if (!res.ok) log('warn', 'Failed to send stop command', res.error);
  else log('info', 'Stop command sent', res.resp);
  startBtn.disabled = false; stopBtn.disabled = true;
});

/* Start: try execScript, otherwise fall back to content script messaging */
startBtn.addEventListener('click', async () => {
  startBtn.disabled = true; stopBtn.disabled = false;
  await saveSettings();
  const cfg = collectSettingsFromUI();
  log('info', 'Starting job', { summary: `blocks ${cfg.startBlockX},${cfg.startBlockY} -> ${cfg.endBlockX},${cfg.endBlockY}` });

  const tab = await api.queryActiveTab();
  if (!tab || !tab.id) { log('error', 'Active tab not found'); startBtn.disabled = false; stopBtn.disabled = true; return; }

  const execRes = await api.execScript(tab.id, runFetcherInIsolatedWorld, [cfg]);
  if (execRes.ok) {
    try {
      // Normalize result shape across different browsers
      const payload = (execRes.res && execRes.res[0] && execRes.res[0].result) || (execRes.res && execRes.res.result) || null;
      if (!payload) log('error', 'executeScript returned no valid result');
      else if (!payload.ok) log('error', 'Fetch failed: ' + (payload.error || 'unknown'));
      else {
        log('info', `Done: total=${payload.total} records=${payload.records.length} elapsed=${payload.elapsed}s`, payload.stats || {});
        if (payload.records && payload.records.length) {
          try {
            const txt = payload.records.map(x => JSON.stringify(x)).join('\n');
            const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download = `auto_fetch_${Date.now()}.txt`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
            log('info', 'Download triggered');
          } catch (e) { log('error', 'Download failed: ' + String(e)); }
        } else log('info', 'No records to download');
      }
    } catch (e) { log('error', 'Failed to handle executeScript result: ' + String(e)); }
    startBtn.disabled = false; stopBtn.disabled = true;
    return;
  }

  // Fallback: ask content script to inject/run
  log('warn', 'execScript unavailable or failed, falling back to content script injection: ' + (execRes.error || ''));
  const msgRes = await api.sendMessageToTab(tab.id, { type: 'inject-script', payload: cfg });
  if (!msgRes.ok) { log('error', 'Fallback injection failed: ' + (msgRes.error || '')); startBtn.disabled = false; stopBtn.disabled = true; return; }
  log('info', 'Requested content script injection (ensure main.js is registered as content script)', msgRes.resp);

  // Poll recent events from content script for updates
  const poll = setInterval(async () => {
    const evRes = await api.sendMessageToTab(tab.id, { type: 'get-recent-events' });
    if (!evRes.ok) return;
    const arr = evRes.resp && evRes.resp.recent;
    if (!arr || !arr.length) return;
    arr.forEach(ev => { const p = ev.payload || {}; log('info', (p.evt || 'evt') + ' ' + (p.text || ''), p); });
  }, 1000);
  setTimeout(() => clearInterval(poll), 1000 * 60 * 5);
});

/* On open: load settings and try to read recent events */
document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  const tab = await api.queryActiveTab();
  if (!tab || !tab.id) return;
  const evRes = await api.sendMessageToTab(tab.id, { type: 'get-recent-events' });
  if (!evRes.ok) return;
  const arr = evRes.resp && evRes.resp.recent;
  if (!arr || !arr.length) return;
  arr.forEach(ev => { const p = ev.payload || {}; log('info', (p.evt || 'evt') + ' ' + (p.text || ''), p); });
});

/* ==== Fetch loop (this is the function injected/run via execScript) ==== */
async function runFetcherInIsolatedWorld(cfg) {
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function TokenBucket(rate, capacity) {
    this.rate = rate;
    this.capacity = capacity;
    this._tokens = capacity;
    this._last = performance.now();
  }
  TokenBucket.prototype.consume = function(tokens) {
    if (tokens == null) tokens = 1;
    const now = performance.now();
    const elapsed = (now - this._last) / 1000;
    this._last = now;
    this._tokens = Math.min(this.capacity, this._tokens + elapsed * this.rate);
    if (tokens <= this._tokens) { this._tokens -= tokens; return 0; }
    const need = (tokens - this._tokens) / this.rate;
    this._tokens = 0;
    return need * 1000;
  };

  try {
    const startBlockX = Number(cfg.startBlockX || 0);
    const startBlockY = Number(cfg.startBlockY || 0);
    const startX = Number(cfg.startX || 0);
    const startY = Number(cfg.startY || 0);
    const endBlockX = Number(cfg.endBlockX || startBlockX);
    const endBlockY = Number(cfg.endBlockY || startBlockY);
    const endX = Number(cfg.endX || startX);
    const endY = Number(cfg.endY || startY);
    const stepX = Math.max(1, Number(cfg.stepX || 1));
    const stepY = Math.max(1, Number(cfg.stepY || 1));
    const CONCURRENCY = Math.max(1, Number(cfg.CONCURRENCY || 4));
    const MAX_RPS = Math.max(1, Number(cfg.MAX_RPS || 6));
    const BATCH_PAUSE_MS = Number(cfg.BATCH_PAUSE_MS || 800);
    const MAX_ATTEMPTS = Math.max(1, Number(cfg.MAX_ATTEMPTS || 5));
    const BACKOFF_BASE_MS = Number(cfg.BACKOFF_BASE_MS || 500);
    const BACKOFF_MAX_MS = Number(cfg.BACKOFF_MAX_MS || 30000);
    const BLOCK_SIZE = Number(cfg.BLOCK_SIZE || 1000);

    let BASE_TPL = (bx, by, lx, ly) => 'https://backend.wplace.live/s0/pixel/' + bx + '/' + by + '?x=' + lx + '&y=' + ly;
    if (typeof cfg.BASE_TEMPLATE === 'string' && cfg.BASE_TEMPLATE.trim()) {
      const tpl = cfg.BASE_TEMPLATE.trim();
      if (tpl.indexOf('{blockX}') !== -1) {
        BASE_TPL = (bx, by, lx, ly) => tpl.replace(/\{blockX\}/g, bx).replace(/\{blockY\}/g, by).replace(/\{lx\}/g, lx).replace(/\{ly\}/g, ly);
      } else {
        BASE_TPL = (bx, by, lx, ly) => tpl + (tpl.endsWith('/') ? '' : '/') + bx + '/' + by + '?x=' + lx + '&y=' + ly;
      }
    }

    function toGlobal(bx, by, lx, ly) { return { gx: bx * BLOCK_SIZE + lx, gy: by * BLOCK_SIZE + ly }; }
    function toBlock(gx, gy) {
      const blockX = Math.floor(gx / BLOCK_SIZE);
      const blockY = Math.floor(gy / BLOCK_SIZE);
      const lx = ((gx % BLOCK_SIZE) + BLOCK_SIZE) % BLOCK_SIZE;
      const ly = ((gy % BLOCK_SIZE) + BLOCK_SIZE) % BLOCK_SIZE;
      return { blockX, blockB: blockY, lx, ly };
    }

    const g1 = toGlobal(startBlockX, startBlockY, startX, startY);
    const g2 = toGlobal(endBlockX, endBlockY, endX, endY);
    const minGX = Math.min(g1.gx, g2.gx), maxGX = Math.max(g1.gx, g2.gx);
    const minGY = Math.min(g1.gy, g2.gy), maxGY = Math.max(g1.gy, g2.gy);

    if (stepX <= 0 || stepY <= 0) return { ok: false, error: 'stepX/stepY must be > 0' };

    const coords = [];
    for (let gx = minGX; gx <= maxGX; gx += stepX) {
      for (let gy = minGY; gy <= maxGY; gy += stepY) {
        const b = toBlock(gx, gy);
        coords.push({ blockX: b.blockX, blockB: b.blockB, x: b.lx, y: b.ly });
      }
    }

    const bucket = new TokenBucket(MAX_RPS, Math.max(1, MAX_RPS));
    const records = [];
    const seenIds = new Set();
    const stats = { ok: 0, fail: 0, _429: 0, _403: 0, err: 0 };

    async function fetchWithRetry(coord) {
      const url = BASE_TPL(coord.blockX, coord.blockB, coord.x, coord.y);
      let attempt = 0;
      let backoff = BACKOFF_BASE_MS + Math.floor(Math.random() * 200);
      while (attempt < MAX_ATTEMPTS) {
        attempt++;
        const wait = bucket.consume(1);
        if (wait > 0) await sleep(wait + Math.floor(Math.random() * 50));
        try {
          const resp = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
          if (resp.ok) {
            const data = await resp.json().catch(() => null);
            if (data) {
              const pb = data.paintedBy || null;
              const pbId = pb && pb.id != null ? String(pb.id) : null;
              if (pbId !== null) {
                if (pbId !== '0' && !seenIds.has(pbId)) {
                  const pbCopy = (pb && typeof pb === 'object') ? Object.assign({}, pb) : pb;
                  if (pbCopy && 'picture' in pbCopy) delete pbCopy.picture;
                  seenIds.add(pbId);
                  records.push({ blockX: coord.blockX, blockB: coord.blockB, x: coord.x, y: coord.y, paintedBy: pbCopy });
                }
              } else {
                const pbCopy = (pb && typeof pb === 'object') ? Object.assign({}, pb) : pb;
                if (pbCopy && 'picture' in pbCopy) delete pbCopy.picture;
                records.push({ blockX: coord.blockX, blockB: coord.blockB, x: coord.x, y: coord.y, paintedBy: pbCopy });
              }
            }
            stats.ok++; return { ok: true };
          } else {
            stats.fail++;
            if (resp.status === 429) stats._429++;
            if (resp.status === 403) stats._403++;
            if (resp.status === 429 || resp.status === 403) {
              const extra = backoff + Math.floor(Math.random() * backoff);
              await sleep(extra);
              backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
              continue;
            } else return { ok: false, status: resp.status };
          }
        } catch (e) {
          stats.err++;
          await sleep(backoff + Math.floor(Math.random() * 200));
          backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
        }
      }
      return { ok: false, reason: 'max-retries' };
    }

    const t0 = performance.now();
    for (let i = 0; i < coords.length; i += CONCURRENCY) {
      const batch = coords.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async c => {
        await sleep(Math.floor(Math.random() * 120));
        await fetchWithRetry(c);
        return;
      }));
      await sleep(BATCH_PAUSE_MS + Math.floor(Math.random() * BATCH_PAUSE_MS));
    }

    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    return { ok: true, total: coords.length, records, elapsed, stats };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
