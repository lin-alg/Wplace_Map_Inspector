// popup.js - 更稳健的修复版（基于你提供的完整文件，修复常见异步/引用边界）
/* 说明
 - 保留原有功能：设置持久化、storage.onChanged、polling、stop/retry
 - 强化错误捕获与调试日志，保证 sendMessage 回调总 resolve，避免未捕获异常中断
*/

const api = (function() {
  const hasBrowser = typeof browser !== 'undefined';
  const raw = hasBrowser ? browser : (typeof chrome !== 'undefined' ? chrome : null);

  function queryActiveTab() {
    return new Promise(resolve => {
      try { raw.tabs.query({ active: true, currentWindow: true }, tabs => resolve((tabs && tabs[0]) || null)); }
      catch (e) { console.warn('[POPUP] queryActiveTab error', e); resolve(null); }
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

  async function storageGetCompat(key) {
    try {
      if (raw && raw.storage && raw.storage.local) {
        return await new Promise(resolve => {
          raw.storage.local.get([key], res => {
            const err = (raw.runtime && raw.runtime.lastError) || null;
            if (err) {
              try { const v = localStorage.getItem(key); resolve(v ? JSON.parse(v) : undefined); } catch (e) { resolve(undefined); }
              return;
            }
            if (res && res[key] !== undefined) resolve(res[key]);
            else resolve(res);
          });
        });
      }
    } catch (e) { /* fallthrough */ }
    try { const rawVal = localStorage.getItem(key); return rawVal ? JSON.parse(rawVal) : undefined; } catch (e) { return undefined; }
  }

  async function storageSetCompat(key, value) {
    try {
      if (raw && raw.storage && raw.storage.local) {
        return await new Promise(resolve => {
          const obj = {}; obj[key] = value;
          raw.storage.local.set(obj, () => {
            const err = (raw.runtime && raw.runtime.lastError) || null;
            if (err) {
              try { localStorage.setItem(key, JSON.stringify(value)); resolve({ ok: true, fallback: 'localStorage' }); } catch (e) { resolve({ ok: false, error: String(err) }); }
              return;
            }
            resolve({ ok: true });
          });
        });
      }
    } catch (e) { /* fallthrough */ }
    try { localStorage.setItem(key, JSON.stringify(value)); return { ok: true, fallback: 'localStorage' }; } catch (e) { return { ok: false, error: String(e) }; }
  }

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
    } catch (e) { /* continue */ }
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
            try {
              const code = '(' + func.toString() + ').apply(null, ' + JSON.stringify(args || []) + ');';
              raw.tabs.executeScript(tabId, { code }, results => {
                const err = raw.runtime && raw.runtime.lastError;
                if (err) return reject(err);
                resolve(results);
              });
            } catch (err3) { return reject(err3); }
          }
        });
        return { ok: true, mode: 'tabs-exec', res };
      }
    } catch (e) { /* continue */ }
    return { ok: false, error: 'no-exec-api' };
  }

  return { raw, queryActiveTab, sendMessageToTab, storageGet: storageGetCompat, storageSet: storageSetCompat, execScript };
})();

/* UI elements (safe lookup) */
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
  BATCH_SIZE: document.getElementById('BATCH_SIZE'),
  BATCH_DELAY_MINUTES: document.getElementById('BATCH_DELAY_MINUTES'),
  BASE_TEMPLATE: document.getElementById('BASE_TEMPLATE')
};

const pickStartBtn = document.getElementById('pickStartBtn');
const pickEndBtn = document.getElementById('pickEndBtn');
const SETTINGS_KEY = 'pxf_settings';
const RUN_STATE_KEY = '__PXF_RUNNING__';
const STOP_FLAG_KEY = '__PIXEL_FETCHER_STOP__';
const PROGRESS_KEY = '__PXF_PROGRESS__';

/* Pick helpers: request page to return coords (uses content script grabCoords) */
async function pickCoordsFromPage() {
  try {
    const tab = await api.queryActiveTab();
    if (!tab || !tab.id) return { ok: false, error: 'no-active-tab' };

    // Try direct message to content script; ensureContentScriptAndSend will try to inject if missing
    const resp = await ensureContentScriptAndSend(tab.id, { type: 'grabCoords' }, 1500);
    if (resp && resp.ok && resp.resp) {
      const r = resp.resp;
      // content script uses sendResponse({ ok:true, coords })
      if (r.ok && r.coords) return { ok: true, coords: r.coords };
      return { ok: false, error: r.error || 'no-coords', raw: r.raw };
    }
    return { ok: false, error: resp && resp.error ? resp.error : 'no-response' };
  } catch (e) { return { ok: false, error: String(e) }; }
}

async function applyPickedCoords(kind /* 'start' or 'end' */) {
  const res = await pickCoordsFromPage();
  if (!res || !res.ok) {
    log('error', `Pick ${kind} failed`, { error: res && res.error, raw: res && res.raw });
    return;
  }
  const c = res.coords;
  if (!c) { log('error', `Pick ${kind} parse failed`, res); return; }

  if (kind === 'start') {
    if (inputs.startBlockX) inputs.startBlockX.value = String(c.tlX || 0);
    if (inputs.startBlockY) inputs.startBlockY.value = String(c.tlY || 0);
    if (inputs.startX) inputs.startX.value = String(c.pxX || 0);
    if (inputs.startY) inputs.startY.value = String(c.pxY || 0);
    log('info', 'Picked start coords', c);
  } else {
    if (inputs.endBlockX) inputs.endBlockX.value = String(c.tlX || 0);
    if (inputs.endBlockY) inputs.endBlockY.value = String(c.tlY || 0);
    if (inputs.endX) inputs.endX.value = String(c.pxX || 0);
    if (inputs.endY) inputs.endY.value = String(c.pxY || 0);
    log('info', 'Picked end coords', c);
  }

  // Save immediately so popup state persists
  try { await saveSettings(); } catch (e) { /* best-effort */ }
}

/* wire pick buttons after DOM ready */
document.addEventListener('DOMContentLoaded', () => {
  const pickStartBtn = document.getElementById('pickStartBtn');
  const pickEndBtn = document.getElementById('pickEndBtn');

  if (pickStartBtn) {
    pickStartBtn.addEventListener('click', async () => {
      pickStartBtn.disabled = true;
      try { await applyPickedCoords('start'); }
      finally { pickStartBtn.disabled = false; }
    });
  }

  if (pickEndBtn) {
    pickEndBtn.addEventListener('click', async () => {
      pickEndBtn.disabled = true;
      try { await applyPickedCoords('end'); }
      finally { pickEndBtn.disabled = false; }
    });
  }
});

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
  } catch (e) { /* ignore */ }
  if (type === 'error') console.error(text, extra || '');
  else if (type === 'warn') console.warn(text, extra || '');
  else console.log(text, extra || '');
}

function setRunningUI(isRunning) {
  if (startBtn) startBtn.disabled = isRunning;
  if (stopBtn) stopBtn.disabled = !isRunning;
}

function collectSettingsFromUI() {
  try {
    return {
      startBlockX: Number(inputs.startBlockX?.value || 0),
      startBlockY: Number(inputs.startBlockY?.value || 0),
      startX: Number(inputs.startX?.value || 0),
      startY: Number(inputs.startY?.value || 0),
      endBlockX: Number(inputs.endBlockX?.value || 0),
      endBlockY: Number(inputs.endBlockY?.value || 0),
      endX: Number(inputs.endX?.value || 0),
      endY: Number(inputs.endY?.value || 0),
      stepX: Math.max(1, Number(inputs.stepX?.value || 1)),
      stepY: Math.max(1, Number(inputs.stepY?.value || 1)),
      CONCURRENCY: Number(inputs.CONCURRENCY?.value || 4),
      MAX_RPS: Number(inputs.MAX_RPS?.value || 6),
      BATCH_SIZE: Math.max(1, Number(inputs.BATCH_SIZE?.value || 10)),
      BATCH_DELAY_MINUTES: Math.max(0, Number(inputs.BATCH_DELAY_MINUTES?.value || 0.05)),
      BASE_TEMPLATE: (inputs.BASE_TEMPLATE?.value || '').trim()
    };
  } catch (e) {
    console.warn('[POPUP] collectSettingsFromUI error', e);
    return {
      startBlockX: 0, startBlockY: 0, startX: 0, startY: 0,
      endBlockX: 0, endBlockY: 0, endX: 0, endY: 0,
      stepX: 1, stepY: 1, CONCURRENCY: 4, MAX_RPS: 6,
      BATCH_SIZE: 10, BATCH_DELAY_MINUTES: 0.05, BASE_TEMPLATE: ''
    };
  }
}

function estimateCountFromCfg(cfg) {
  try {
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
  } catch (e) { return 0; }
}

/* Settings persistence */
let saveTimer = null;
function scheduleSaveSettings() { if (saveTimer) clearTimeout(saveTimer); saveTimer = setTimeout(saveSettings, 300); }
async function saveSettings() {
  try {
    const cfg = collectSettingsFromUI();
    const r = await api.storageSet(SETTINGS_KEY, cfg);
    if (r && r.ok) log('info','Settings saved' + (r.fallback ? ` (fallback:${r.fallback})` : ''));
    else log('warn','Failed to save settings', r && r.error);
  } catch (e) { console.warn('[POPUP] saveSettings error', e); }
}
async function loadSettings() {
  try {
    const cfg = await api.storageGet(SETTINGS_KEY);
    if (cfg) Object.keys(inputs).forEach(k => { if (cfg[k] != null && inputs[k]) inputs[k].value = String(cfg[k]); });
  } catch (e) { console.warn('[POPUP] loadSettings error', e); }
}

Object.values(inputs).forEach(el => { if (!el) return; el.addEventListener('input', scheduleSaveSettings); });
if (clearBtn) clearBtn.addEventListener('click', () => { if (logEl) logEl.innerHTML = ''; });

/* Helper: ensure content script is present and send a message; inject main.js if necessary */
async function ensureContentScriptAndSend(tabId, msg, timeoutMs = 1200) {
  try {
    const resp = await new Promise(resolve => {
      try { chrome.tabs.sendMessage(tabId, msg, r => resolve(r)); }
      catch (e) { resolve(null); }
    });
    if (resp !== null && resp !== undefined) return { ok: true, resp };
  } catch (e) { /* ignore */ }

  try {
    await api.execScript(tabId, function() { return true; }, []);
    const resp2 = await new Promise(resolve => {
      try { chrome.tabs.sendMessage(tabId, msg, r => resolve(r)); }
      catch (e) { resolve(null); }
    });
    if (resp2 !== null && resp2 !== undefined) return { ok: true, resp: resp2 };
  } catch (e) { return { ok: false, error: String(e) }; }

  return { ok: false, error: 'no-content-script' };
}

document.addEventListener('DOMContentLoaded', async () => {
  const toggle = document.getElementById('advToggle');
  const body = document.getElementById('advBody');

  if (body) {
    if (!body.style.display) body.style.display = 'none';
  }
  if (toggle && body) {
    toggle.innerText = (body.style.display !== 'none') ? 'Hide advanced ▴' : 'Show advanced ▾';
    toggle.setAttribute('aria-expanded', body.style.display !== 'none');
    toggle.addEventListener('click', (e) => {
      e.preventDefault();
      const isOpen = body.style.display !== 'none';
      if (isOpen) {
        body.style.display = 'none';
        toggle.innerText = 'Show advanced ▾';
        toggle.setAttribute('aria-expanded', 'false');
      } else {
        body.style.display = 'block';
        toggle.innerText = 'Hide advanced ▴';
        toggle.setAttribute('aria-expanded', 'true');
      }
    });
  }

  await loadSettings();

  try {
    const tab = await api.queryActiveTab();
    if (!tab || !tab.id) { setRunningUI(false); return; }

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
    } catch (e) { setRunningUI(false); }

  } catch (e) {
    console.warn('[POPUP] DOMContentLoaded flow error', e);
    setRunningUI(false);
  }

  // add storage change listener so popup stays in sync
  if (api.raw && api.raw.storage && api.raw.storage.onChanged) {
    api.raw.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      try {
        if (changes[RUN_STATE_KEY]) {
          const newVal = changes[RUN_STATE_KEY].newValue;
          const isRunning = !!(newVal && newVal.running);
          setRunningUI(isRunning);
        }
        if (changes[STOP_FLAG_KEY]) {
          const v = changes[STOP_FLAG_KEY].newValue;
          const stopped = (v === '1' || v === 1 || v === true || v === 'true');
          if (stopped) setRunningUI(false);
        }
        if (changes[PROGRESS_KEY]) {
          const p = changes[PROGRESS_KEY].newValue;
          if (p && (p.finished || p.stopped)) setRunningUI(false);
        }
      } catch (e) { /* best-effort */ }
    });
  }

  // start short polling to show new events while popup is open
  let pollTimer = null;
  const pollSeen = new Set();

  async function pollProgressAndEvents() {
    try {
      const pRaw = await api.storageGet(PROGRESS_KEY);
      const progress = pRaw && (pRaw.__PXF_PROGRESS__ || pRaw) || null;
      if (progress) {
        const key = JSON.stringify({ done: progress.done, total: progress.total, ts: progress.timestamp || progress.timestampMs || '' }).slice(0,200);
        if (!pollSeen.has(key)) {
          pollSeen.add(key);
          displayProgress(progress);
        }
      }
      const tab = await api.queryActiveTab();
      if (tab && tab.id) {
        const evRes2 = await ensureContentScriptAndSend(tab.id, { type: 'get-recent-events' });
        if (evRes2 && evRes2.ok && Array.isArray(evRes2.resp && evRes2.resp.recent)) {
          evRes2.resp.recent.forEach(ev => {
            const p = ev.payload || {};
            const key = (ev.time ? String(ev.time) : '') + '|' + (p.evt || '') + '|' + (p.text || '');
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
        }
      }
    } catch (e) { /* ignore */ }
  }

  function displayProgress(progress) {
    if (!progress) return;
    const done = progress.done || 0;
    const total = progress.total || 0;
    const finished = !!progress.finished;
    const lastBatch = progress.lastBatch || null;

    if (lastBatch) {
      const ts = new Date(lastBatch.batchTimestamp || progress.timestamp || Date.now());
      const durationMs = lastBatch.batchDurationMs != null ? lastBatch.batchDurationMs : null;
      const elapsedSec = lastBatch.batchElapsedSec != null ? lastBatch.batchElapsedSec : null;
      if (durationMs != null) log('info', `Batch ${lastBatch.batchStartIndex}→${lastBatch.batchEndIndex} (${lastBatch.batchCount}) at ${ts.toLocaleTimeString()}`, { durationMs, elapsedSec });
      else log('info', `Progress ${done}/${total}`, progress);
    } else {
      log('info', `Progress ${done}/${total}`, progress);
    }

    if (finished || (done && total && done === total)) setRunningUI(false);
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(pollProgressAndEvents, 1200);
    pollProgressAndEvents();
  }
  startPolling();
  window.addEventListener('unload', () => { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } });
});

/* Stop (改进版): 等待 background 确认后再更新 UI */
if (stopBtn) stopBtn.addEventListener('click', async () => {
  stopBtn.disabled = true;
  try { await api.storageSet(STOP_FLAG_KEY, '1'); } catch (e) {}
  const res = await new Promise(resolve => {
    try { chrome.runtime.sendMessage({ type: 'stop-fetch' }, r => resolve(r)); }
    catch (err) { resolve({ ok: false, error: String(err) }); }
  });
  if (!res || !res.ok) { log('warn', 'Background stop may have failed', res && res.error); stopBtn.disabled = false; return; }
  try { await api.storageSet(RUN_STATE_KEY, null); await api.storageSet(STOP_FLAG_KEY, null); } catch (e) {}
  log('info', 'Stop acknowledged by background');
  setRunningUI(false);
});

/* Start */
if (startBtn) startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  if (stopBtn) stopBtn.disabled = false;
  await saveSettings();
  const cfg = collectSettingsFromUI();
  const estimated = estimateCountFromCfg(cfg);
  log('info', 'Starting job via background', { summary: `blocks ${cfg.startBlockX},${cfg.startBlockY} -> ${cfg.endBlockX},${cfg.endBlockY}`, estimatedCount: estimated });

  try { console.log('[POPUP] sending start cfg:', cfg); } catch (e) {}

  try { await api.storageSet(STOP_FLAG_KEY, null); } catch (e) {}

  const sendStart = async () => {
    return await new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type: 'start-fetch', cfg }, res => {
          try { console.log('[POPUP] start-fetch response ->', res); } catch (e) {}
          resolve(res);
        });
      } catch (err) { console.log('[POPUP] sendMessage error', err); resolve({ ok: false, error: String(err) }); }
    });
  };

  const startResp = await sendStart();

  if (startResp && startResp.ok) {
    try { await api.storageSet(RUN_STATE_KEY, { running: true, startedAt: Date.now(), cfg }); } catch (e) {}
    log('info', 'Background accepted start', { jobId: startResp.jobId });
    return;
  }

  if (startResp && startResp.error === 'already-running') {
    log('warn', 'Detected already-running. Attempting to stop existing job and retry start');
    try { await api.storageSet(STOP_FLAG_KEY, '1'); } catch (e) {}

    const stopResp = await new Promise(resolve => {
      try { chrome.runtime.sendMessage({ type: 'stop-fetch' }, r => resolve(r)); }
      catch (err) { resolve({ ok: false, error: String(err) }); }
    });
    if (!stopResp || !stopResp.ok) {
      log('error', 'Stop request failed or not acknowledged by background', stopResp && stopResp.error);
      startBtn.disabled = false;
      if (stopBtn) stopBtn.disabled = true;
      return;
    }
    log('info', 'Stop acknowledged, waiting for background to clear state');

    const WAIT_TIMEOUT_MS = 20000;
    const POLL_INTERVAL_MS = 400;
    const t0 = Date.now();
    let cleared = false;

    while (Date.now() - t0 < WAIT_TIMEOUT_MS) {
      try {
        const s = await api.storageGet(RUN_STATE_KEY);
        const j = await api.storageGet('__PXF_JOB_STORE__');
        const runStateVal = s && (s.__PXF_RUNNING__ || s);
        const jobStoreVal = j && (j.__PXF_JOB_STORE__ || j);
        const runStill = !!(runStateVal && runStateVal.running);
        const jobStill = !!jobStoreVal;
        if (!runStill && !jobStill) { cleared = true; break; }
      } catch (e) { /* ignore */ }
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }

    if (!cleared) {
      log('warn', 'Background state did not clear within timeout; please check service worker console', { timeoutMs: WAIT_TIMEOUT_MS });
    } else {
      log('info', 'Background state cleared, retrying start');
    }

    try { await api.storageSet(RUN_STATE_KEY, null); } catch (e) {}
    try { await api.storageSet(STOP_FLAG_KEY, null); } catch (e) {}

    const retryResp = await sendStart();
    if (retryResp && retryResp.ok) {
      try { await api.storageSet(RUN_STATE_KEY, { running: true, startedAt: Date.now(), cfg }); } catch (e) {}
      log('info', 'Retry start succeeded', { jobId: retryResp.jobId });
      return;
    }

    log('error', 'Start failed after retry', retryResp && retryResp.error);
    startBtn.disabled = false;
    if (stopBtn) stopBtn.disabled = true;
    return;
  }

  log('error', 'Background start failed', startResp && startResp.error);
  startBtn.disabled = false;
  if (stopBtn) stopBtn.disabled = true;
});
