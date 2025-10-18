// main.js - content script
// Keep injection listener and injection function, and maintain recentEvents cache inside the content script; popup fetches via chrome.tabs.sendMessage

// Recent events cache (content script scope)
const __PIXEL_FETCHER_RECENT__ = {
  events: [], // stores recent event objects
  maxLen: 300
};

// helper: push event to cache and keep size
function pushRecentEvent(evt) {
  try {
    __PIXEL_FETCHER_RECENT__.events.push(evt);
    if (__PIXEL_FETCHER_RECENT__.events.length > __PIXEL_FETCHER_RECENT__.maxLen) {
      __PIXEL_FETCHER_RECENT__.events.splice(0, __PIXEL_FETCHER_RECENT__.events.length - __PIXEL_FETCHER_RECENT__.maxLen);
    }
  } catch (e) { /* noop */ }
}

// Listen for window.postMessage from the page context (the injected script uses window.postMessage to emit events)
window.addEventListener('message', (ev) => {
  const data = ev.data;
  if (!data || !data.__PIXEL_FETCHER__) return;
  // Cache the event inside the content script so popup can query it
  pushRecentEvent({ payload: data, time: Date.now() });
});

// Listen for control messages from popup (inject / stop / get-recent-events / clear-recent-events)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'inject-script' && msg.payload) {
    injectFetcherScript(msg.payload);
    sendResponse({ injected: true });
    return true;
  }

  if (msg.type === 'stop-script') {
    // Send stop event to the page script
    window.postMessage({ __PIXEL_FETCHER__: true, cmd: 'stop' }, '*');
    sendResponse({ stopped: true });
    return true;
  }

  if (msg.type === 'get-recent-events') {
    // Return recent events and optionally clear (caller decides)
    sendResponse({ recent: __PIXEL_FETCHER_RECENT__.events.slice() });
    return true;
  }

  if (msg.type === 'clear-recent-events') {
    __PIXEL_FETCHER_RECENT__.events.length = 0;
    sendResponse({ cleared: true });
    return true;
  }
});

// Inject script into the page context. payload is a settings object (serialized into the page script)
// Use plain string concatenation to avoid template literal nesting issues
function injectFetcherScript(payload) {
  const s = document.createElement('script');
  s.type = 'text/javascript';
  const cfg = JSON.stringify(payload || {});
  // Prevent "</script>" substring from prematurely closing the injected script
  const safeCfg = cfg.replace(/<\/script>/gi, '<\\/script>');
  s.textContent =
"(function(){\n" +
"  try {\n" +
"    if (window.__PIXEL_FETCHER_RUNNING__) {\n" +
"      window.postMessage({ __PIXEL_FETCHER__: true, evt: 'info', text: '已有实例在运行, 已请求停止旧实例' }, '*');\n" +
"      window.postMessage({ __PIXEL_FETCHER__: true, cmd: 'stop' }, '*');\n" +
"    }\n" +
"    window.__PIXEL_FETCHER_RUNNING__ = true;\n" +
"    window.__PIXEL_FETCHER_STOP__ = false;\n" +
"\n" +
"    window.addEventListener('message', function(ev){\n" +
"      var d = ev.data;\n" +
"      if (!d || !d.__PIXEL_FETCHER__) return;\n" +
"      if (d.cmd === 'stop') { window.__PIXEL_FETCHER_STOP__ = true; }\n" +
"    });\n" +
"\n" +
"    var CONFIG = " + safeCfg + ";\n" +
"\n" +
"    function emit(evt, obj){\n" +
"      var payload = Object.assign({ __PIXEL_FETCHER__: true, evt: evt }, obj || {});\n" +
"      window.postMessage(payload, '*');\n" +
"    }\n" +
"\n" +
"    var safe = (typeof CONFIG === 'object' && CONFIG !== null) ? CONFIG : {};\n" +
"    var startBlockX = Number(safe.startBlockX != null ? safe.startBlockX : 1677);\n" +
"    var startBlockY = Number(safe.startBlockY != null ? safe.startBlockY : 888);\n" +
"    var startX = Number(safe.startX != null ? safe.startX : 165);\n" +
"    var startY = Number(safe.startY != null ? safe.startY : 942);\n" +
"\n" +
"    var endBlockX = Number(safe.endBlockX != null ? safe.endBlockX : 1677);\n" +
"    var endBlockY = Number(safe.endBlockY != null ? safe.endBlockY : 888);\n" +
"    var endX = Number(safe.endX != null ? safe.endX : 167);\n" +
"    var endY = Number(safe.endY != null ? safe.endY : 945);\n" +
"\n" +
"    var stepX = Math.max(1, Number(safe.stepX != null ? safe.stepX : 1));\n" +
"    var stepY = Math.max(1, Number(safe.stepY != null ? safe.stepY : 1));\n" +
"\n" +
"    var CONCURRENCY = Math.max(1, Number(safe.CONCURRENCY != null ? safe.CONCURRENCY : 4));\n" +
"    var MAX_RPS = Math.max(1, Number(safe.MAX_RPS != null ? safe.MAX_RPS : 6));\n" +
"    var BATCH_PAUSE_MS = Number(safe.BATCH_PAUSE_MS != null ? safe.BATCH_PAUSE_MS : 800);\n" +
"    var MAX_ATTEMPTS = Math.max(1, Number(safe.MAX_ATTEMPTS != null ? safe.MAX_ATTEMPTS : 5));\n" +
"    var BACKOFF_BASE_MS = Number(safe.BACKOFF_BASE_MS != null ? safe.BACKOFF_BASE_MS : 500);\n" +
"    var BACKOFF_MAX_MS = Number(safe.BACKOFF_MAX_MS != null ? safe.BACKOFF_MAX_MS : 30000);\n" +
"    var LOG_INTERVAL = Number(safe.LOG_INTERVAL != null ? safe.LOG_INTERVAL : 50);\n" +
"    var STATUS_INTERVAL_MS = Number(safe.STATUS_INTERVAL_MS != null ? safe.STATUS_INTERVAL_MS : 5000);\n" +
"    var BLOCK_SIZE = Number(safe.BLOCK_SIZE != null ? safe.BLOCK_SIZE : 1000);\n" +
"\n" +
"    var BASE_TPL = function(blockX, blockY, lx, ly){\n" +
"      return 'https://backend.wplace.live/s0/pixel/' + blockX + '/' + blockY + '?x=' + lx + '&y=' + ly;\n" +
"    };\n" +
"    if (typeof safe.BASE_TEMPLATE === 'function') {\n" +
"      BASE_TPL = safe.BASE_TEMPLATE;\n" +
"    } else if (typeof safe.BASE_TEMPLATE === 'string' && safe.BASE_TEMPLATE.trim()) {\n" +
"      (function(){\n" +
"        var tpl = safe.BASE_TEMPLATE.trim();\n" +
"        if (tpl.indexOf('{blockX}') !== -1 || tpl.indexOf('{lx}') !== -1) {\n" +
"          BASE_TPL = function(blockX, blockY, lx, ly){\n" +
"            return tpl.replace(/\\{blockX\\}/g, blockX).replace(/\\{blockY\\}/g, blockY).replace(/\\{lx\\}/g, lx).replace(/\\{ly\\}/g, ly);\n" +
"          };\n" +
"        } else if (tpl.indexOf('${') !== -1) {\n" +
"          try {\n" +
"            var safeTpl = tpl.replace(/`/g, '\\\\`');\n" +
"            BASE_TPL = new Function('blockX','blockY','lx','ly', 'return `' + safeTpl + '`;');\n" +
"          } catch (e) { }\n" +
"        } else {\n" +
"          var prefix = tpl;\n" +
"          BASE_TPL = function(blockX, blockY, lx, ly){\n" +
"            if (prefix.indexOf('?') !== -1) {\n" +
"              return prefix + '&blockX=' + blockX + '&blockY=' + blockY + '&x=' + lx + '&y=' + ly;\n" +
"            }\n" +
"            return prefix + (prefix.endsWith('/') ? '' : '/') + blockX + '/' + blockY + '?x=' + lx + '&y=' + ly;\n" +
"          };\n" +
"        }\n" +
"      })();\n" +
"    }\n" +
"\n" +
"    function toGlobal(bx, by, lx, ly){ return { gx: bx * BLOCK_SIZE + lx, gy: by * BLOCK_SIZE + ly }; }\n" +
"    function toBlock(gx, gy){\n" +
"      var blockX = Math.floor(gx / BLOCK_SIZE);\n" +
"      var blockY = Math.floor(gy / BLOCK_SIZE);\n" +
"      var lx = ((gx % BLOCK_SIZE) + BLOCK_SIZE) % BLOCK_SIZE;\n" +
"      var ly = ((gy % BLOCK_SIZE) + BLOCK_SIZE) % BLOCK_SIZE;\n" +
"      return { blockX: blockX, blockY: blockY, lx: lx, ly: ly };\n" +
"    }\n" +
"\n" +
"    var g1 = toGlobal(startBlockX, startBlockY, startX, startY);\n" +
"    var g2 = toGlobal(endBlockX, endBlockY, endX, endY);\n" +
"    var minGX = Math.min(g1.gx, g2.gx), maxGX = Math.max(g1.gx, g2.gx);\n" +
"    var minGY = Math.min(g1.gy, g2.gy), maxGY = Math.max(g1.gy, g2.gy);\n" +
"\n" +
"    if (stepX <= 0 || stepY <= 0) { emit('error', { text: 'stepX/stepY must be > 0' }); window.__PIXEL_FETCHER_RUNNING__ = false; return; }\n" +
"\n" +
"    var estCount = (Math.floor((maxGX - minGX) / stepX) + 1) * (Math.floor((maxGY - minGY) / stepY) + 1);\n" +
"    emit('info', { text: '范围全局 gx=' + minGX + '..' + maxGX + ', gy=' + minGY + '..' + maxGY + ', 预计点数=' + estCount });\n" +
"\n" +
"    var coords = [];\n" +
"    for (var gx = minGX; gx <= maxGX; gx += stepX) {\n" +
"      for (var gy = minGY; gy <= maxGY; gy += stepY) {\n" +
"        var b = toBlock(gx, gy);\n" +
"        coords.push({ blockX: b.blockX, blockY: b.blockY, x: b.lx, y: b.ly });\n" +
"      }\n" +
"    }\n" +
"    if (!coords.length) { emit('info', { text: '无坐标任务' }); window.__PIXEL_FETCHER_RUNNING__ = false; return; }\n" +
"\n" +
"    for (var i = coords.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var tmp = coords[i]; coords[i] = coords[j]; coords[j] = tmp; }\n" +
"\n" +
"    function TokenBucket(rate, capacity){ this.rate = rate; this.capacity = capacity; this._tokens = capacity; this._last = performance.now(); }\n" +
"    TokenBucket.prototype.consume = function(tokens){ if (tokens == null) tokens = 1; var now = performance.now(); var elapsed = (now - this._last)/1000; this._last = now; this._tokens = Math.min(this.capacity, this._tokens + elapsed * this.rate); if (tokens <= this._tokens) { this._tokens -= tokens; return 0; } var need = (tokens - this._tokens) / this.rate; this._tokens = 0; return need * 1000; };\n" +
"    var bucket = new TokenBucket(MAX_RPS, Math.max(1, MAX_RPS));\n" +
"\n" +
"    var seenIds = new Set(); var ids = new Set(); var records = []; var done = 0; var stats = { ok:0, fail:0, _429:0, _403:0, err:0 };\n" +
"    function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }\n" +
"\n" +
"    var statusTimer = null;\n" +
"    function startStatusTimer(t0){ if (statusTimer) return; statusTimer = setInterval(function(){ var elapsed = ((performance.now() - t0)/1000).toFixed(1); var errRatio = ((stats._429 + stats._403) / Math.max(1, done)); emit('status', { elapsed: elapsed, done: done, total: coords.length, ids: ids.size, records: records.length, stats: stats, errRatio: errRatio }); }, STATUS_INTERVAL_MS); }\n" +
"    function stopStatusTimer(){ if (!statusTimer) return; clearInterval(statusTimer); statusTimer = null; }\n" +
"\n" +
"    async function fetchWithRetry(coord){\n" +
"      var url = BASE_TPL(coord.blockX, coord.blockY, coord.x, coord.y);\n" +
"      var attempt = 0; var backoff = BACKOFF_BASE_MS + Math.floor(Math.random()*200);\n" +
"      while (attempt < MAX_ATTEMPTS) {\n" +
"        attempt++;\n" +
"        var wait = bucket.consume(1);\n" +
"        if (wait > 0) await sleep(wait + Math.floor(Math.random()*50));\n" +
"        if (window.__PIXEL_FETCHER_STOP__) return { ok:false, reason: 'stopped' };\n" +
"        try {\n" +
"          var resp = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });\n" +
"          if (resp.ok) {\n" +
"            var data = await resp.json().catch(function(){ return null; });\n" +
"            if (data) {\n" +
"              var pb = data.paintedBy || null;\n" +
"              var pbId = (pb && (pb.id != null)) ? String(pb.id) : null;\n" +
"              if (pbId !== null) {\n" +
"                if (pbId !== '0' && !seenIds.has(pbId)) {\n" +
"                  var pbCopy = (pb && typeof pb === 'object') ? Object.assign({}, pb) : pb; if (pbCopy && ('picture' in pbCopy)) delete pbCopy.picture;\n" +
"                  seenIds.add(pbId); ids.add(pbId);\n" +
"                  records.push({ blockX: coord.blockX, blockY: coord.blockY, x: coord.x, y: coord.y, paintedBy: pbCopy });\n" +
"                }\n" +
"              } else {\n" +
"                var pbCopy2 = (pb && typeof pb === 'object') ? Object.assign({}, pb) : pb; if (pbCopy2 && ('picture' in pbCopy2)) delete pbCopy2.picture;\n" +
"                records.push({ blockX: coord.blockX, blockY: coord.blockY, x: coord.x, y: coord.y, paintedBy: pbCopy2 });\n" +
"              }\n" +
"            }\n" +
"            stats.ok++; return { ok:true, status:200 };\n" +
"          } else {\n" +
"            stats.fail++; if (resp.status === 429) stats._429++; if (resp.status === 403) stats._403++;\n" +
"            if (resp.status === 429 || resp.status === 403) { var extra = backoff + Math.floor(Math.random()*backoff); await sleep(extra); backoff = Math.min(BACKOFF_MAX_MS, backoff * 2); continue; } else return { ok:false, status: resp.status };\n" +
"          }\n" +
"        } catch (e) { stats.err++; await sleep(backoff + Math.floor(Math.random()*200)); backoff = Math.min(BACKOFF_MAX_MS, backoff * 2); }\n" +
"      }\n" +
"      return { ok:false, reason:'max-retries' };\n" +
"    }\n" +
"\n" +
"    async function runAll(t0){ startStatusTimer(t0); for (var i = 0; i < coords.length; i += CONCURRENCY) { if (window.__PIXEL_FETCHER_STOP__) { emit('info', { text: '检测到停止信号，终止任务' }); break; } var batch = coords.slice(i, i + CONCURRENCY); var runners = batch.map(function(c){ return (async function(c2){ await sleep(Math.floor(Math.random()*120)); var r = await fetchWithRetry(c2); done++; if (done % LOG_INTERVAL === 0 || done === coords.length) emit('progress', { done: done, total: coords.length, ids: ids.size, records: records.length, stats: stats }); return r; })(c); }); await Promise.all(runners); var pause = BATCH_PAUSE_MS + Math.floor(Math.random()*BATCH_PAUSE_MS); await sleep(pause); var errRatio = (stats._429 + stats._403) / Math.max(1, done); if (errRatio > 0.12) { var extra = Math.min(30000, Math.floor(errRatio * 80000)); emit('warn', { text: '检测到高 429/403 比例，延长冷却', extra: extra }); await sleep(extra); } } stopStatusTimer(); }\n" +
"\n" +
"    emit('info', { text: '开始抓取 total=' + coords.length + ' concurrency=' + CONCURRENCY + ' max_rps=' + MAX_RPS });\n" +
"    var t0 = performance.now();\n" +
"    (async function(){ await runAll(t0); var elapsed = ((performance.now() - t0)/1000).toFixed(1); emit('done', { total: coords.length, unique_nonzero_ids: seenIds.size, records: records.length, elapsed: elapsed, stats: stats });\n" +
"\n" +
"      // Export\n" +
"      if (records.length > 0) {\n" +
"        try {\n" +
"          var lines = records.map(function(r){ return JSON.stringify(r); });\n" +
"          var txt = lines.join(\"\\n\");\n" +
"          var blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });\n" +
"          var fminGX = (typeof minGX !== 'undefined') ? minGX : 'g';\n" +
"          var fminGY = (typeof minGY !== 'undefined') ? minGY : 'g';\n" +
"          var fmaxGX = (typeof maxGX !== 'undefined') ? maxGX : 'g';\n" +
"          var fmaxGY = (typeof maxGY !== 'undefined') ? maxGY : 'g';\n" +
"          var fstepX = (typeof stepX !== 'undefined') ? stepX : 'x';\n" +
"          var fstepY = (typeof stepY !== 'undefined') ? stepY : 'y';\n" +
"          var fname = 'auto_fetch_' + fminGX + '_' + fminGY + '_to_' + fmaxGX + '_' + fmaxGY + '_step' + fstepX + 'x' + fstepY + '.txt';\n" +
"          var url = URL.createObjectURL(blob);\n" +
"          var a = document.createElement('a'); a.href = url; a.download = fname; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);\n" +
"          emit('info', { text: '已下载 ' + fname, lines: lines.length });\n" +
"        } catch (e) { emit('error', { text: '导出失败', err: String(e) }); }\n" +
"      } else { emit('info', { text: '未收集到任何记录' }); }\n" +
"    })();\n" +
"\n" +
"  } catch (err) {\n" +
"    window.postMessage({ __PIXEL_FETCHER__: true, evt: 'error', text: '注入脚本内部异常', err: String(err) }, '*');\n" +
"  } finally {\n" +
"    window.__PIXEL_FETCHER_RUNNING__ = false;\n" +
"  }\n" +
"})();\n";
  (document.documentElement || document.head || document.body).appendChild(s);
  setTimeout(()=>s.remove(), 2000);
}
