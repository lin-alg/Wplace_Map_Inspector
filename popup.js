// popup.js - full file with run-state UI sync, robust messaging for Edge/Chromium, stop support using localStorage + postMessage

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
          if (err) resolve({ ok: false, error: err.message || String(err) });
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
            if (res && res[key] !== undefined) resolve(res[key]);
            else resolve(res);
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

/* ---- Robust messaging helper (ensure content script) ---- */
async function ensureContentScriptAndSend(tabId, msg) {
  let res = await api.sendMessageToTab(tabId, msg);
  if (res && res.ok) return res;

  try {
    const raw = api.raw;
    if (raw && raw.scripting && raw.scripting.executeScript) {
      await new Promise((resolve, reject) => {
        raw.scripting.executeScript({ target: { tabId }, files: ['main.js'] }, () => {
          const err = raw.runtime && raw.runtime.lastError;
          if (err) return reject(err);
          resolve();
        });
      });
    } else if (raw && raw.tabs && raw.tabs.executeScript) {
      await new Promise((resolve) => {
        try {
          raw.tabs.executeScript(tabId, { code: 'void 0;' }, () => { setTimeout(resolve, 80); });
        } catch (e) { setTimeout(resolve, 80); }
      });
    }
    await new Promise(r => setTimeout(r, 150));
    res = await api.sendMessageToTab(tabId, msg);
    return res;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

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

const conservativeCheckbox = document.getElementById('conservative');

const SETTINGS_KEY = 'pxf_settings';
const RUN_STATE_KEY = '__PXF_RUNNING__';
const STOP_FLAG_KEY = '__PIXEL_FETCHER_STOP__';
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

// helper: set UI button states for running vs idle
function setRunningUI(isRunning) {
  if (isRunning) {
    startBtn.disabled = true;
    stopBtn.disabled = false;
  } else {
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }
}

/* Settings helpers */
function collectSettingsFromUI() {
  const rawCfg = {
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

  if (conservativeCheckbox && conservativeCheckbox.checked) {
    rawCfg.CONCURRENCY = 1;
    rawCfg.MAX_RPS = 1;
    rawCfg.BATCH_PAUSE_MS = Math.max(800, rawCfg.BATCH_PAUSE_MS || 800);
  }

  return rawCfg;
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

Object.values(inputs).forEach(el => { if (!el) return; el.addEventListener('input', scheduleSaveSettings); });
clearBtn.addEventListener('click', () => { if (logEl) logEl.innerHTML = ''; });

document.addEventListener('DOMContentLoaded', async () => {
  const toggle = document.getElementById('advToggle');
  const body = document.getElementById('advBody');
  if (toggle && body) {
    toggle.addEventListener('click', (e) => {
      e.preventDefault();
      const isOpen = body.style.display !== 'none';
      if (isOpen) {
        body.style.display = 'none';
        toggle.innerText = 'Show advanced ▾';
      } else {
        body.style.display = 'block';
        toggle.innerText = 'Hide advanced ▴';
      }
    });
  }

  await loadSettings();

  const tab = await api.queryActiveTab();
  if (!tab || !tab.id) {
    setRunningUI(false);
    return;
  }

  // Attempt to get recent events from content script (inject if necessary)
  let arr = [];
  try {
    const evRes = await ensureContentScriptAndSend(tab.id, { type: 'get-recent-events' });
    if (evRes && evRes.ok && evRes.resp && Array.isArray(evRes.resp.recent)) arr = evRes.resp.recent;
  } catch (e) { arr = []; }

  // Fallback to storage for recent events if none
  if (!arr || !arr.length) {
    try {
      const storedRaw = await api.storageGet('__PIXEL_FETCHER_RECENT__');
      let stored = null;
      if (!storedRaw) stored = null;
      else if (Array.isArray(storedRaw)) stored = storedRaw;
      else if (storedRaw.__PIXEL_FETCHER_RECENT__ && Array.isArray(storedRaw.__PIXEL_FETCHER_RECENT__)) stored = storedRaw.__PIXEL_FETCHER_RECENT__;
      else stored = storedRaw;
      if (Array.isArray(stored)) arr = stored;
    } catch (e) { arr = arr || []; }
  }

  if (arr && arr.length) {
    const seen = new Set();
    arr.forEach(ev => {
      const p = ev.payload || {};
      const key = (ev.time ? String(ev.time) : '') + '|' + (p.evt || '') + '|' + (p.text || '');
      if (seen.has(key)) return;
      seen.add(key);
      log('info', (p.evt || 'evt') + ' ' + (p.text || ''), p);
    });
  }

  // Check persisted run state and set UI accordingly
  try {
    const runStateRaw = await api.storageGet(RUN_STATE_KEY);
    let runState = null;
    if (!runStateRaw) runState = null;
    else if (runStateRaw.__PXF_RUNNING__) runState = runStateRaw.__PXF_RUNNING__;
    else runState = runStateRaw;

    if (runState && runState.running) {
      log('info', '检测到运行态，恢复 Stop 可用', { startedAt: runState.startedAt, cfg: runState.cfg });
      setRunningUI(true);
    } else {
      setRunningUI(false);
    }
  } catch (e) {
    setRunningUI(false);
  }

  // start short polling to show new events while popup is open
  let pollTimer = null;
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      const evRes2 = await ensureContentScriptAndSend(tab.id, { type: 'get-recent-events' });
      if (!evRes2 || !evRes2.ok) return;
      const arr2 = evRes2.resp && evRes2.resp.recent;
      if (!arr2 || !arr2.length) return;
      arr2.forEach(ev => {
        const p = ev.payload || {};
        const key = (ev.time ? String(ev.time) : '') + '|' + (p.evt || '') + '|' + (p.text || '');
        if (!key) return;
        if (!pollSeen.has(key)) {
          pollSeen.add(key);
          log('info', (p.evt || 'evt') + ' ' + (p.text || ''), p);
          if (p.evt === 'done' || (p.evt === 'run-state' && p.running === false)) {
            setRunningUI(false);
            try { api.storageSet(RUN_STATE_KEY, null); } catch (e) {}
            try { api.storageSet(STOP_FLAG_KEY, null); } catch (e) {}
          }
        }
      });
    }, 1200);
  }
  const pollSeen = new Set();
  startPolling();
  window.addEventListener('unload', () => { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } });
});

/* Utility: estimate total sample count from settings */
function estimateCountFromCfg(cfg) {
  const BLOCK_SIZE = 1000;
  const g1x = (cfg.startBlockX || 0) * BLOCK_SIZE + (cfg.startX || 0);
  const g1y = (cfg.startBlockY || 0) * BLOCK_SIZE + (cfg.startY || 0);
  const g2x = (cfg.endBlockX || cfg.startBlockX || 0) * BLOCK_SIZE + (cfg.endX || cfg.startX || 0);
  const g2y = (cfg.endBlockY || cfg.startBlockY || 0) * BLOCK_SIZE + (cfg.endY || cfg.startY || 0);
  const minGX = Math.min(g1x, g2x), maxGX = Math.max(g1x, g2x);
  const minGY = Math.min(g1y, g2y), maxGY = Math.max(g1y, g2y);
  const stepX = Math.max(1, Number(cfg.stepX || 1));
  const stepY = Math.max(1, Number(cfg.stepY || 1));
  const countX = Math.floor((maxGX - minGX) / stepX) + 1;
  const countY = Math.floor((maxGY - minGY) / stepY) + 1;
  return Math.max(0, countX * countY);
}

/* Stop (best-effort): tell content script to stop if it exists */
stopBtn.addEventListener('click', async () => {
  stopBtn.disabled = true;
  const tab = await api.queryActiveTab();
  if (!tab || !tab.id) { log('error', 'Active tab not found'); stopBtn.disabled = false; return; }
  // send stop message to content script; it will write localStorage stop flag too
  const res = await ensureContentScriptAndSend(tab.id, { type: 'stop-script' });
  if (!res.ok) {
    log('warn', 'Failed to send stop command', res.error);
    setRunningUI(false);
  } else {
    log('info', 'Stop command sent', res.resp);
    try { await api.storageSet(RUN_STATE_KEY, null); } catch (e) {}
    try { await api.storageSet(STOP_FLAG_KEY, null); } catch (e) {}
    setRunningUI(false);
  }
});

/* Start: try execScript, otherwise fall back to content script messaging */
startBtn.addEventListener('click', async () => {
  startBtn.disabled = true; stopBtn.disabled = false;
  await saveSettings();
  const cfg = collectSettingsFromUI();
  const estimated = estimateCountFromCfg(cfg);
  log('info', 'Starting job', { summary: `blocks ${cfg.startBlockX},${cfg.startBlockY} -> ${cfg.endBlockX},${cfg.endBlockY}`, estimatedCount: estimated });

  const tab = await api.queryActiveTab();
  if (!tab || !tab.id) { log('error', 'Active tab not found'); setRunningUI(false); return; }

  const LARGE_THRESHOLD = 20000;
  if (estimated > LARGE_THRESHOLD) {
    log('warn', `Estimated ${estimated} samples exceeds threshold ${LARGE_THRESHOLD}, using content-script injection (safer for large jobs)`);
    const msgRes = await ensureContentScriptAndSend(tab.id, { type: 'inject-script', payload: Object.assign({}, cfg, { estimatedCount: estimated }) });
    if (!msgRes.ok) { log('error', 'Content-script injection failed: ' + (msgRes.error || '')); setRunningUI(false); return; }
    log('info', 'Requested content script injection', msgRes.resp);
    setRunningUI(true);
    try { await api.storageSet(RUN_STATE_KEY, { running: true, startedAt: Date.now(), cfg: cfg }); } catch (e) {}
    // clear any prior stop flag before run
    try { await api.storageSet(STOP_FLAG_KEY, null); } catch (e) {}
    const seenKeys = new Set();
    const poll = setInterval(async () => {
      const evRes = await ensureContentScriptAndSend(tab.id, { type: 'get-recent-events' });
      if (!evRes.ok) return;
      const arr = evRes.resp && evRes.resp.recent;
      if (!arr || !arr.length) return;
      arr.forEach(ev => {
        const p = ev.payload || {};
        const key = (ev.time ? String(ev.time) : '') + '|' + (p.evt || '') + '|' + (p.text || '');
        if (seenKeys.has(key)) return;
        seenKeys.add(key);
        log('info', (p.evt || 'evt') + ' ' + (p.text || ''), p);
        if (p.evt === 'done' || (p.evt === 'run-state' && p.running === false)) {
          clearInterval(poll);
          setRunningUI(false);
          try { api.storageSet(RUN_STATE_KEY, null); } catch (e) {}
          try { api.storageSet(STOP_FLAG_KEY, null); } catch (e) {}
        }
      });
    }, 1200);
    setTimeout(() => clearInterval(poll), 1000 * 60 * 60 * 6);
    return;
  }

  const execRes = await api.execScript(tab.id, runFetcherInIsolatedWorld, [cfg]);
  if (!execRes.ok) {
    log('warn', 'execScript unavailable or failed, falling back to content script injection: ' + (execRes.error || ''));
  } else {
    try {
      const payload = (execRes.res && execRes.res[0] && execRes.res[0].result) || (execRes.res && execRes.res.result) || null;
      if (!payload) log('error', 'executeScript returned no valid result');
      else if (!payload.ok) log('error', 'Fetch failed: ' + (payload.error || 'unknown'));
      else {
        const total = payload.total || (payload.recordsCount || 0);
        log('info', `execScript summary total=${total} elapsed=${payload.elapsed}s`, payload.stats || {});
        if (total && payload.elapsed) {
          const approxPer10 = ((payload.elapsed / Math.max(1, total)) * 10).toFixed(2);
          log('info', `approx elapsed per 10 samples (avg): ${approxPer10}s`);
        }

        const recCount = payload.records ? payload.records.length : 0;
        if (recCount && recCount <= 500 && payload.records) {
          try {
            const txt = payload.records.map(x => JSON.stringify(x)).join('\n');
            const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download = `auto_fetch_${Date.now()}.txt`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
            log('info', 'Download triggered for returned records');
          } catch (e) { log('error', 'Download failed: ' + String(e)); }
        } else if (total > 0 && recCount === 0) {
          log('info', 'Large job completed in page context or results truncated; use content-script injection for browser download if needed');
        } else {
          log('info', 'No records to download');
        }
      }
    } catch (e) { log('error', 'Failed to handle executeScript result: ' + String(e)); }
    setRunningUI(false);
    return;
  }

  const msgRes = await ensureContentScriptAndSend(tab.id, { type: 'inject-script', payload: Object.assign({}, cfg, { estimatedCount: estimated }) });
  if (!msgRes.ok) { log('error', 'Fallback injection failed: ' + (msgRes.error || '')); setRunningUI(false); return; }
  log('info', 'Requested content script injection (fallback)', msgRes.resp);
  setRunningUI(true);
  try { await api.storageSet(RUN_STATE_KEY, { running: true, startedAt: Date.now(), cfg: cfg }); } catch (e) {}
  try { await api.storageSet(STOP_FLAG_KEY, null); } catch (e) {}

  const seenKeys = new Set();
  const poll = setInterval(async () => {
    const evRes = await ensureContentScriptAndSend(tab.id, { type: 'get-recent-events' });
    if (!evRes.ok) return;
    const arr = evRes.resp && evRes.resp.recent;
    if (!arr || !arr.length) return;
    arr.forEach(ev => {
      const p = ev.payload || {};
      const key = (ev.time ? String(ev.time) : '') + '|' + (p.evt || '') + '|' + (p.text || '');
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
      log('info', (p.evt || 'evt') + ' ' + (p.text || ''), p);
      if (p.evt === 'done' || (p.evt === 'run-state' && p.running === false)) {
        clearInterval(poll);
        setRunningUI(false);
        try { api.storageSet(RUN_STATE_KEY, null); } catch (e) {}
        try { api.storageSet(STOP_FLAG_KEY, null); } catch (e) {}
      }
    });
  }, 1200);
  setTimeout(() => clearInterval(poll), 1000 * 60 * 60 * 6);
});

/* ==== Fetch loop (executeScript path) ==== */
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

  // helper to emit messages from execScript context to page (picked up by content script)
  function emitLocal(evt, obj) {
    try {
      const payload = Object.assign({ __PIXEL_FETCHER__: true, evt: evt }, obj || {});
      window.postMessage(payload, '*');
    } catch (e) { /* noop */ }
  }

  // stop flag for execScript/isolated-world path and listener
  window.__PIXEL_FETCHER_STOP__ = false;
  window.addEventListener('message', function(ev) {
    try {
      const d = ev.data;
      if (!d || !d.__PIXEL_FETCHER__) return;
      if (d.cmd === 'stop') {
        window.__PIXEL_FETCHER_STOP__ = true;
        try { localStorage.setItem(STOP_FLAG_KEY, '1'); } catch (e) {}
        emitLocal('info', { text: '检测到停止信号，设置停止标志' });
        emitLocal('run-state', { running: false });
      }
    } catch (e) {}
  }, false);

  // stop checker that reads localStorage as authoritative cross-context signal
  function isStoppedLocal() {
    try {
      if (window.__PIXEL_FETCHER_STOP__) return true;
      try {
        var v = localStorage.getItem(STOP_FLAG_KEY);
        if (v === '1' || v === 'true') return true;
      } catch (e) {}
    } catch (e) {}
    return false;
  }

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
    let CONCURRENCY = Math.max(1, Number(cfg.CONCURRENCY || 4));
    let MAX_RPS = Math.max(1, Number(cfg.MAX_RPS || 6));
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
      const blockB = Math.floor(gy / BLOCK_SIZE);
      const lx = ((gx % BLOCK_SIZE) + BLOCK_SIZE) % BLOCK_SIZE;
      const ly = ((gy % BLOCK_SIZE) + BLOCK_SIZE) % BLOCK_SIZE;
      return { blockX, blockB, lx, ly };
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

    for (let i = coords.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [coords[i], coords[j]] = [coords[j], coords[i]];
    }

    emitLocal('info', { text: '[runFetcherInIsolatedWorld] estimated samples: ' + coords.length, total: coords.length });

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
        if (isStoppedLocal()) return { ok:false, reason: 'stopped' };
        const wait = bucket.consume(1);
        if (wait > 0) await sleep(wait + Math.floor(Math.random() * 50));
        if (isStoppedLocal()) return { ok:false, reason: 'stopped' };
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
              const retryAfter = (() => { try { return resp.headers.get('Retry-After'); } catch (e) { return null; } })();
              let extra = backoff + Math.floor(Math.random() * backoff);
              if (retryAfter) {
                const ra = parseInt(retryAfter, 10);
                if (!isNaN(ra)) extra = Math.max(extra, ra * 1000);
                else { const date = Date.parse(retryAfter); if (!isNaN(date)) extra = Math.max(extra, Math.max(0, date - Date.now())); }
              }
              const errRatio = (stats._429 + stats._403) / Math.max(1, Math.max(1, stats.ok + stats.fail + stats.err));
              if (errRatio > 0.02) {
                const newConcurrency = Math.max(1, Math.floor(CONCURRENCY * 0.7));
                const newMaxRps = Math.max(1, Math.floor(MAX_RPS * 0.7));
                if (newConcurrency < CONCURRENCY || newMaxRps < MAX_RPS) {
                  CONCURRENCY = newConcurrency; MAX_RPS = newMaxRps;
                  bucket.rate = MAX_RPS;
                  bucket.capacity = Math.max(1, MAX_RPS);
                  emitLocal('warn', { text: '[runFetcherInIsolatedWorld] adaptive throttling applied', CONCURRENCY: CONCURRENCY, MAX_RPS: MAX_RPS });
                }
              }
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
    let done = 0;
    for (let i = 0; i < coords.length; i += CONCURRENCY) {
      if (isStoppedLocal()) { emitLocal('info', { text: '检测到停止标志，终止任务' }); break; }
      const batch = coords.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async c => {
        await sleep(Math.floor(Math.random() * 120));
        await fetchWithRetry(c);
        done++;
        if (done % 10 === 0) {
          const now = performance.now();
          const batchElapsed = ((now - t0) / 1000).toFixed(2);
          emitLocal('progress', { text: `[runFetcherInIsolatedWorld] progress ${done}/${coords.length}`, done: done, total: coords.length, elapsed: batchElapsed });
        }
      }));
      await sleep(BATCH_PAUSE_MS + Math.floor(Math.random() * BATCH_PAUSE_MS));
      const errRatio = (stats._429 + stats._403) / Math.max(1, done);
      if (errRatio > 0.12) {
        const extra = Math.min(60000, Math.floor(errRatio * 120000));
        emitLocal('warn', { text: '[runFetcherInIsolatedWorld] high 429/403 ratio, cooling down', extra: extra });
        await sleep(extra);
      }
    }

    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    try { localStorage.removeItem(STOP_FLAG_KEY); } catch (e) {}
    const sampleLimit = 200;
    const sample = records.length > sampleLimit ? records.slice(0, sampleLimit) : records;
    return { ok: true, total: coords.length, records: sample, recordsTruncated: records.length > sampleLimit, recordsCount: records.length, elapsed, stats };
  } catch (err) {
    emitLocal('error', { text: '[runFetcherInIsolatedWorld] internal error', err: String(err) });
    try { localStorage.removeItem(STOP_FLAG_KEY); } catch (e) {}
    return { ok: false, error: String(err) };
  }
}