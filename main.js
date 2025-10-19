// main.js - content script (modified to persist run state so popup can recover)
// - Keeps recent event cache and popup messaging
// - injectFetcherScript injects a page-context fetcher whose logic matches the provided console script
// - Persists run state key __PXF_RUNNING__ and clears it on stop/done
// - Writes a localStorage unified stop flag so all contexts can observe stop requests

// Recent events cache (content script scope)
const __PIXEL_FETCHER_RECENT__ = { events: [], maxLen: 300 };

// Persisted run state key
const RUN_STATE_KEY = '__PXF_RUNNING__';
const STOP_FLAG_KEY = '__PIXEL_FETCHER_STOP__';

// Persist recent events to storage (throttled)
let __saveTimer = null;
function saveRecentEventsToStorage() {
  try {
    const snapshot = __PIXEL_FETCHER_RECENT__.events.slice(-__PIXEL_FETCHER_RECENT__.maxLen);
    if (chrome && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ __PIXEL_FETCHER_RECENT__: snapshot }, () => { /* no-op */ });
    } else {
      localStorage.setItem('__PIXEL_FETCHER_RECENT__', JSON.stringify(snapshot));
    }
  } catch (e) { /* noop */ }
}
function loadRecentEventsFromStorage() {
  try {
    if (chrome && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['__PIXEL_FETCHER_RECENT__'], (res) => {
        const arr = res && res.__PIXEL_FETCHER_RECENT__;
        if (Array.isArray(arr)) __PIXEL_FETCHER_RECENT__.events = arr.slice(-__PIXEL_FETCHER_RECENT__.maxLen);
      });
    } else {
      const raw = localStorage.getItem('__PIXEL_FETCHER_RECENT__');
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) __PIXEL_FETCHER_RECENT__.events = arr.slice(-__PIXEL_FETCHER_RECENT__.maxLen);
      }
    }
  } catch (e) { /* noop */ }
}
loadRecentEventsFromStorage();

function pushRecentEvent(evt) {
  try {
    __PIXEL_FETCHER_RECENT__.events.push(evt);
    if (__PIXEL_FETCHER_RECENT__.events.length > __PIXEL_FETCHER_RECENT__.maxLen) {
      __PIXEL_FETCHER_RECENT__.events.splice(0, __PIXEL_FETCHER_RECENT__.events.length - __PIXEL_FETCHER_RECENT__.maxLen);
    }
    if (__saveTimer) clearTimeout(__saveTimer);
    __saveTimer = setTimeout(() => { saveRecentEventsToStorage(); __saveTimer = null; }, 800);
  } catch (e) { /* noop */ }

  // also forward to background for persistence if available (best-effort)
  try {
    if (chrome && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ type: 'bg-log-event', payload: evt }, function(resp) { /* best-effort */ });
    }
  } catch (e) { /* noop */ }
}

// Helpers for run state persistence
function persistRunState(obj) {
  try {
    if (chrome && chrome.storage && chrome.storage.local) {
      const o = {}; o[RUN_STATE_KEY] = obj;
      chrome.storage.local.set(o, () => {});
    } else {
      localStorage.setItem(RUN_STATE_KEY, JSON.stringify(obj));
    }
  } catch (e) {}
}
function clearRunState() {
  try {
    if (chrome && chrome.storage && chrome.storage.local) {
      chrome.storage.local.remove(RUN_STATE_KEY, () => {});
    } else {
      localStorage.removeItem(RUN_STATE_KEY);
    }
  } catch (e) {}
}
function setStopFlagInStorage() {
  try {
    try {
      if (chrome && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ [STOP_FLAG_KEY]: true }, () => {});
      }
    } catch (e) {}
    localStorage.setItem(STOP_FLAG_KEY, '1');
  } catch (e) {}
}
function clearStopFlagInStorage() {
  try {
    try {
      if (chrome && chrome.storage && chrome.storage.local) {
        chrome.storage.local.remove(STOP_FLAG_KEY, () => {});
      }
    } catch (e) {}
    localStorage.removeItem(STOP_FLAG_KEY);
  } catch (e) {}
}

// Receive events from injected page script
window.addEventListener('message', (ev) => {
  const data = ev.data;
  if (!data || !data.__PIXEL_FETCHER__) return;
  pushRecentEvent({ payload: data, time: Date.now() });

  // handle lifecycle signals from injected script
  try {
    if (data.evt === 'done') {
      clearRunState();
      clearStopFlagInStorage();
    }
    if (data.evt === 'info' && typeof data.text === 'string' && data.text.indexOf('检测到停止信号') !== -1) {
      clearRunState();
      // leave stop flag until cleanup, but clear run state
    }
    if (data.evt === 'run-state' && data.running === false) {
      clearRunState();
      clearStopFlagInStorage();
    }
  } catch (e) {}
});

// Listen for control messages from popup (inject / stop / get-recent-events / clear-recent-events)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'inject-script' && msg.payload) {
    injectFetcherScript(msg.payload);
    // persist run state meta so popup can recover after close/open
    try {
      const meta = { running: true, startedAt: Date.now(), cfg: msg.payload || {} };
      persistRunState(meta);
      // ensure stop flag cleared before start
      try { clearStopFlagInStorage(); } catch (e) {}
    } catch (e) {}
    sendResponse({ injected: true });
    return true;
  }

  if (msg.type === 'stop-script') {
    // forward stop to page-context fetcher
    try {
      window.postMessage({ __PIXEL_FETCHER__: true, cmd: 'stop' }, '*');
    } catch (e) {}

    // ALSO write a stop flag to localStorage so all contexts can see it
    setStopFlagInStorage();

    // immediately clear persisted run state (best-effort)
    clearRunState();
    sendResponse({ stopped: true });
    return true;
  }

  if (msg.type === 'get-recent-events') {
    sendResponse({ recent: __PIXEL_FETCHER_RECENT__.events.slice() });
    return true;
  }

  if (msg.type === 'clear-recent-events') {
    __PIXEL_FETCHER_RECENT__.events.length = 0;
    try {
      if (chrome && chrome.storage && chrome.storage.local) chrome.storage.local.remove('__PIXEL_FETCHER_RECENT__', () => {});
      else localStorage.removeItem('__PIXEL_FETCHER_RECENT__');
    } catch (e) {}
    sendResponse({ cleared: true });
    return true;
  }
});

// Inject script into the page context. payload is a settings object (serialized into the page script)
function injectFetcherScript(payload) {
  const s = document.createElement('script');
  s.type = 'text/javascript';
  const cfg = JSON.stringify(payload || {});
  const safeCfg = cfg.replace(/<\/script>/gi, '<\\/script>');

  s.textContent =
"(async () => {\n" +
"  try {\n" +
"    const CONFIG = " + safeCfg + " || {};\n" +
"    const startBlockX = Number(CONFIG.startBlockX != null ? CONFIG.startBlockX : 1677);\n" +
"    const startBlockY = Number(CONFIG.startBlockY != null ? CONFIG.startBlockY : 888);\n" +
"    const startX = Number(CONFIG.startX != null ? CONFIG.startX : 165);\n" +
"    const startY = Number(CONFIG.startY != null ? CONFIG.startY : 942);\n" +
"    const endBlockX = Number(CONFIG.endBlockX != null ? CONFIG.endBlockX : startBlockX);\n" +
"    const endBlockY = Number(CONFIG.endBlockY != null ? CONFIG.endBlockY : startBlockY);\n" +
"    const endX = Number(CONFIG.endX != null ? CONFIG.endX : startX);\n" +
"    const endY = Number(CONFIG.endY != null ? CONFIG.endY : startY);\n" +
"    const stepX = Math.max(1, Number(CONFIG.stepX != null ? CONFIG.stepX : 1));\n" +
"    const stepY = Math.max(1, Number(CONFIG.stepY != null ? CONFIG.stepY : 1));\n" +
"    let CONCURRENCY = Math.max(1, Number(CONFIG.CONCURRENCY != null ? CONFIG.CONCURRENCY : 4));\n" +
"    let MAX_RPS = Math.max(1, Number(CONFIG.MAX_RPS != null ? CONFIG.MAX_RPS : 6));\n" +
"    const BATCH_PAUSE_MS = Number(CONFIG.BATCH_PAUSE_MS != null ? CONFIG.BATCH_PAUSE_MS : 800);\n" +
"    const MAX_ATTEMPTS = Math.max(1, Number(CONFIG.MAX_ATTEMPTS != null ? CONFIG.MAX_ATTEMPTS : 5));\n" +
"    const BACKOFF_BASE_MS = Number(CONFIG.BACKOFF_BASE_MS != null ? CONFIG.BACKOFF_BASE_MS : 500);\n" +
"    const BACKOFF_MAX_MS = Number(CONFIG.BACKOFF_MAX_MS != null ? CONFIG.BACKOFF_MAX_MS : 30000);\n" +
"    const LOG_INTERVAL = Number(CONFIG.LOG_INTERVAL != null ? CONFIG.LOG_INTERVAL : 50);\n" +
"    const STATUS_INTERVAL_MS = Number(CONFIG.STATUS_INTERVAL_MS != null ? CONFIG.STATUS_INTERVAL_MS : 5000);\n" +
"    const BLOCK_SIZE = Number(CONFIG.BLOCK_SIZE != null ? CONFIG.BLOCK_SIZE : 1000);\n" +
"    const BASE_TEMPLATE = (typeof CONFIG.BASE_TEMPLATE === 'string' && CONFIG.BASE_TEMPLATE.trim()) ? CONFIG.BASE_TEMPLATE.trim() : null;\n" +
"    const BASE_TPL = (blockX, blockB, lx, ly) => {\n" +
"      if (BASE_TEMPLATE) {\n" +
"        if (BASE_TEMPLATE.indexOf('{blockX}') !== -1) return BASE_TEMPLATE.replace(/\\{blockX\\}/g, blockX).replace(/\\{blockB\\}/g, blockB).replace(/\\{lx\\}/g, lx).replace(/\\{ly\\}/g, ly);\n" +
"        return BASE_TEMPLATE + (BASE_TEMPLATE.endsWith('/') ? '' : '/') + blockX + '/' + blockB + '?x=' + lx + '&y=' + ly;\n" +
"      }\n" +
"      return 'https://backend.wplace.live/s0/pixel/' + blockX + '/' + blockB + '?x=' + lx + '&y=' + ly;\n" +
"    };\n" +
"    function emit(evt, obj) { var payload = Object.assign({ __PIXEL_FETCHER__: true, evt: evt }, obj || {}); window.postMessage(payload, '*'); }\n" +
"\n" +
"    // unified stop flag: global + localStorage check\n" +
"    window.__PIXEL_FETCHER_STOP__ = false;\n" +
"    function isStopped() {\n" +
"      try {\n" +
"        if (window.__PIXEL_FETCHER_STOP__) return true;\n" +
"        var s = null; try { s = localStorage.getItem('__PIXEL_FETCHER_STOP__'); } catch (e) { s = null; }\n" +
"        if (s === '1' || s === 'true' || s === true) return true;\n" +
"      } catch (e) {}\n" +
"      return false;\n" +
"    }\n" +
"    window.addEventListener('message', function(ev) {\n" +
"      try {\n" +
"        const d = ev.data;\n" +
"        if (!d || !d.__PIXEL_FETCHER__) return;\n" +
"        if (d.cmd === 'stop') {\n" +
"          window.__PIXEL_FETCHER_STOP__ = true;\n" +
"          try { localStorage.setItem('__PIXEL_FETCHER_STOP__', '1'); } catch (e) {}\n" +
"          emit('info', { text: '检测到停止信号，设置停止标志' });\n" +
"          emit('run-state', { running: false });\n" +
"        }\n" +
"      } catch (e) {}\n" +
"    }, false);\n" +
"\n" +
"    function toGlobal(bx, by, lx, ly){ return { gx: bx * BLOCK_SIZE + lx, gy: by * BLOCK_SIZE + ly }; }\n" +
"    function toBlock(gx, gy){\n" +
"      const blockX = Math.floor(gx / BLOCK_SIZE);\n" +
"      const blockB = Math.floor(gy / BLOCK_SIZE);\n" +
"      const lx = ((gx % BLOCK_SIZE) + BLOCK_SIZE) % BLOCK_SIZE;\n" +
"      const ly = ((gy % BLOCK_SIZE) + BLOCK_SIZE) % BLOCK_SIZE;\n" +
"      return { blockX, blockB, lx, ly };\n" +
"    }\n" +
"\n" +
"    const g1 = toGlobal(startBlockX, startBlockY, startX, startY);\n" +
"    const g2 = toGlobal(endBlockX, endBlockY, endX, endY);\n" +
"    const minGX = Math.min(g1.gx, g2.gx), maxGX = Math.max(g1.gx, g2.gx);\n" +
"    const minGY = Math.min(g1.gy, g2.gy), maxGY = Math.max(g1.gy, g2.gy);\n" +
"\n" +
"    if (stepX <= 0 || stepY <= 0) { emit('error', { text: 'stepX/stepY must be > 0' }); return; }\n" +
"\n" +
"    const estCount = (Math.floor((maxGX - minGX) / stepX) + 1) * (Math.floor((maxGY - minGY) / stepY) + 1);\n" +
"    emit('info', { text: '范围全局 gx=' + minGX + '..' + maxGX + ', gy=' + minGY + '..' + maxGY + ', 预计点数=' + estCount });\n" +
"    if (estCount > 500000) { emit('warn', { text: '预计点数非常大: ' + estCount }); }\n" +
"\n" +
"    const coords = [];\n" +
"    for (let gx = minGX; gx <= maxGX; gx += stepX) {\n" +
"      for (let gy = minGY; gy <= maxGY; gy += stepY) {\n" +
"        const b = toBlock(gx, gy);\n" +
"        coords.push({ blockX: b.blockX, blockB: b.blockB, x: b.lx, y: b.ly });\n" +
"      }\n" +
"    }\n" +
"    if (!coords.length) { emit('info', { text: '无坐标任务' }); return; }\n" +
"\n" +
"    for (let i = coords.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const tmp = coords[i]; coords[i] = coords[j]; coords[j] = tmp; }\n" +
"    emit('info', { text: '预计采样点数=' + coords.length });\n" +
"\n" +
"    function TokenBucket(rate, capacity){ this.rate = rate; this.capacity = capacity; this._tokens = capacity; this._last = performance.now(); }\n" +
"    TokenBucket.prototype.consume = function(tokens){ if (tokens==null) tokens=1; var now = performance.now(); var elapsed = (now - this._last)/1000; this._last = now; this._tokens = Math.min(this.capacity, this._tokens + elapsed * this.rate); if (tokens <= this._tokens) { this._tokens -= tokens; return 0; } var need = (tokens - this._tokens) / this.rate; this._tokens = 0; return need * 1000; };\n" +
"    var bucket = new TokenBucket(MAX_RPS, Math.max(1, MAX_RPS));\n" +
"    var seenIds = new Set(); var ids = new Set(); var records = []; var done = 0; var stats = { ok:0, fail:0, _429:0, _403:0, err:0 };\n" +
"    function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }\n" +
"\n" +
"    var statusTimer = null; function startStatusTimer(t0){ if (statusTimer) return; statusTimer = setInterval(function(){ var elapsed = ((performance.now() - t0)/1000).toFixed(1); var errRatio = ((stats._429 + stats._403) / Math.max(1, done)); emit('status', { elapsed: elapsed, done: done, total: coords.length, ids: ids.size, records: records.length, stats: stats, errRatio: errRatio }); }, STATUS_INTERVAL_MS); }\n" +
"    function stopStatusTimer(){ if (!statusTimer) return; clearInterval(statusTimer); statusTimer = null; }\n" +
"\n" +
"    async function fetchWithRetry(coord){\n" +
"      var url = BASE_TPL(coord.blockX, coord.blockB, coord.x, coord.y);\n" +
"      var attempt = 0; var backoff = BACKOFF_BASE_MS + Math.floor(Math.random()*200);\n" +
"      while (attempt < MAX_ATTEMPTS) {\n" +
"        attempt++;\n" +
"        if (isStopped()) return { ok:false, reason: 'stopped' };\n" +
"        var wait = bucket.consume(1);\n" +
"        if (wait > 0) await sleep(wait + Math.floor(Math.random()*50));\n" +
"        if (isStopped()) return { ok:false, reason: 'stopped' };\n" +
"        try {\n" +
"          var resp = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });\n" +
"          if (resp.ok) {\n" +
"            var data = await resp.json().catch(function(){ return null; });\n" +
"            if (data) {\n" +
"              var pb = data.paintedBy || null; var pbId = pb && pb.id != null ? String(pb.id) : null;\n" +
"              if (pbId !== null) {\n" +
"                if (pbId !== '0' && !seenIds.has(pbId)) { var pbCopy = (pb && typeof pb === 'object') ? Object.assign({}, pb) : pb; if (pbCopy && ('picture' in pbCopy)) delete pbCopy.picture; seenIds.add(pbId); ids.add(pbId); records.push({ blockX: coord.blockX, blockB: coord.blockB, x: coord.x, y: coord.y, paintedBy: pbCopy }); }\n" +
"              } else { var pbCopy2 = (pb && typeof pb === 'object') ? Object.assign({}, pb) : pb; if (pbCopy2 && ('picture' in pbCopy2)) delete pbCopy2.picture; records.push({ blockX: coord.blockX, blockB: coord.blockB, x: coord.x, y: coord.y, paintedBy: pbCopy2 }); }\n" +
"            }\n" +
"            stats.ok++; return { ok:true, status:200 };\n" +
"          } else {\n" +
"            stats.fail++; if (resp.status === 429) stats._429++; if (resp.status === 403) stats._403++;\n" +
"            var retryAfter = null; try { retryAfter = resp.headers.get('Retry-After'); } catch(e) { retryAfter = null; }\n" +
"            if (resp.status === 429 || resp.status === 403) {\n" +
"              var extra = backoff + Math.floor(Math.random()*backoff);\n" +
"              if (retryAfter) { var ra = parseInt(retryAfter,10); if (!isNaN(ra)) extra = Math.max(extra, ra*1000); else { var d = Date.parse(retryAfter); if (!isNaN(d)) extra = Math.max(extra, Math.max(0, d - Date.now())); } }\n" +
"              var errRatio = (stats._429 + stats._403) / Math.max(1, done);\n" +
"              if (errRatio > 0.05) { var newConcurrency = Math.max(1, Math.floor(CONCURRENCY * 0.6)); var newMaxRps = Math.max(1, Math.floor(MAX_RPS * 0.6)); if (newConcurrency < CONCURRENCY || newMaxRps < MAX_RPS) { CONCURRENCY = newConcurrency; MAX_RPS = newMaxRps; bucket = new TokenBucket(MAX_RPS, Math.max(1, MAX_RPS)); emit('warn', { text: '降低速率与并发以应对 429/403', CONCURRENCY: CONCURRENCY, MAX_RPS: MAX_RPS, errRatio: errRatio }); } }\n" +
"              await sleep(extra); backoff = Math.min(BACKOFF_MAX_MS, backoff * 2); continue;\n" +
"            } else return { ok:false, status: resp.status };\n" +
"          }\n" +
"        } catch (e) { stats.err++; await sleep(backoff + Math.floor(Math.random()*200)); backoff = Math.min(BACKOFF_MAX_MS, backoff * 2); }\n" +
"      }\n" +
"      return { ok:false, reason:'max-retries' };\n" +
"    }\n" +
"\n" +
"    async function runAll(t0){ startStatusTimer(t0); for (var i = 0; i < coords.length; i += CONCURRENCY) { if (isStopped()) { emit('info', { text: '检测到停止标志，终止任务' }); break; } var batch = coords.slice(i, i + CONCURRENCY); var runners = batch.map(function(c){ return (async function(c2){ await sleep(Math.floor(Math.random()*120)); var r = await fetchWithRetry(c2); done++; if (done % 10 === 0) { var now = performance.now(); var batchElapsed = ((now - t0)/1000).toFixed(2); emit('progress', { done: done, total: coords.length, ids: ids.size, records: records.length, stats: stats, batchElapsed: batchElapsed }); emit('info', { text: '[PIXEL_FETCHER] progress: ' + done + '/' + coords.length, done: done, total: coords.length, elapsed: batchElapsed }); } else { if (done % LOG_INTERVAL === 0 || done === coords.length) emit('progress', { done: done, total: coords.length, ids: ids.size, records: records.length, stats: stats }); } return r; })(c); }); await Promise.all(runners); var pause = BATCH_PAUSE_MS + Math.floor(Math.random()*BATCH_PAUSE_MS); await sleep(pause); var errRatio = (stats._429 + stats._403) / Math.max(1, done); if (errRatio > 0.12) { var extra = Math.min(60000, Math.floor(errRatio * 120000)); emit('warn', { text: '检测到高 429/403 比例，延长冷却', extra: extra, errRatio: errRatio }); await sleep(extra); } } stopStatusTimer(); }\n" +
"\n" +
"    emit('info', { text: '开始抓取 total=' + coords.length + ' concurrency=' + CONCURRENCY + ' max_rps=' + MAX_RPS });\n" +
"    const t0 = performance.now();\n" +
"    emit('info', { text: '[PIXEL_FETCHER] estimated samples: ' + coords.length, samples: coords.length });\n" +
"    await runAll(t0);\n" +
"    const elapsed = ((performance.now() - t0)/1000).toFixed(1);\n" +
"    // cleanup stop flag when finished\n" +
"    try { localStorage.removeItem('__PIXEL_FETCHER_STOP__'); } catch (e) {}\n" +
"    emit('done', { total: coords.length, unique_nonzero_ids: seenIds.size, records: records.length, elapsed: elapsed, stats: stats });\n" +
"\n" +
"    if (records.length > 0) {\n" +
"      try {\n" +
"        const lines = records.map(r => JSON.stringify(r));\n" +
"        const blob = new Blob([lines.join(\"\\n\")], { type: 'text/plain;charset=utf-8' });\n" +
"        const fname = `auto_fetch_${minGX||'g'}_${minGY||'g'}_to_${maxGX||'g'}_${maxGY||'g'}_step${stepX}x${stepY}.txt`;\n" +
"        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fname; document.body.appendChild(a); a.click(); a.remove(); emit('info', { text: '已下载 ' + fname, lines: lines.length });\n" +
"      } catch (e) { emit('error', { text: '导出失败', err: String(e) }); }\n" +
"    } else { emit('info', { text: '未收集到任何记录' }); }\n" +
"\n" +
"  } catch (err) { window.postMessage({ __PIXEL_FETCHER__: true, evt: 'error', text: '注入脚本内部异常', err: String(err) }, '*'); }\n" +
"})();\n";

  (document.documentElement || document.head || document.body).appendChild(s);
  setTimeout(()=>s.remove(), 2000);
}
