// content-inject.js
(function(){
  if (window.__WPI_PANEL_INJECTED__) return;
  window.__WPI_PANEL_INJECTED__ = true;

  // create host container
  const host = document.createElement('div');
  host.id = 'wpi-panel-host';
  host.style.position = 'fixed';
  host.style.zIndex = '2147483647';
  host.style.right = '20px';
  host.style.bottom = '20px';
  host.style.pointerEvents = 'auto';
  // attach shadow
  const shadow = host.attachShadow({ mode: 'closed' });

  // style + html (简化并保持与 popup 一致的控件 id)
  const css = `
    :host { all: initial; }
    .panel {
      position: relative;
      width: 420px;
      max-width: calc(100vw - 40px);
      height: 560px;
      display: flex;
      flex-direction: column;
      background: #fff;
      color: #111;
      border-radius: 8px;
      box-shadow: 0 8px 30px rgba(0,0,0,0.2);
      font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial;
      overflow: hidden;
      border: 1px solid #e6e6e6;
    }
    .header {
      padding: 8px 10px;
      background:#f5f5f5;
      border-bottom:1px solid #eee;
      display:flex;
      align-items:center;
      justify-content:space-between;
      cursor:grab;
    }
    .title { font-size:14px; font-weight:600; }
    .header .controls button { margin-left:6px; }
    .body { padding:10px; overflow:auto; flex:1; }
    .grid { display:grid; grid-template-columns:repeat(2,1fr); gap:6px 10px; }
    label { font-size:12px; display:flex; flex-direction:column; }
    input[type="number"], input[type="text"] { padding:6px 8px; font-size:12px; border:1px solid #ddd; border-radius:4px; }
    .controls { display:flex; gap:8px; margin:8px 0; flex-wrap:wrap; }
    button { padding:6px 10px; font-size:13px; border-radius:6px; border:1px solid #ccc; background:#f5f5f5; cursor:pointer; }
    button:disabled { opacity:0.5; cursor:not-allowed; }
    .log { height:200px; overflow:auto; background:#111; color:#d6ffd6; padding:8px; font-family:monospace; font-size:12px; border-radius:6px; }
    .log .info { color:#9fd5ff; }
    .log .warn { color:#ffd39f; }
    .log .error { color:#ffb4b4; }
    .hidden { display:none; }
    .mini { width:260px; height:40px; border-radius:6px; display:flex; align-items:center; justify-content:center; font-weight:600; }
  `;

  const html = `
    <div class="panel" id="panelRoot">
      <div class="header" id="header">
        <div class="title">Wplace_Map_Inspector</div>
        <div class="controls">
        <button id="minBtn" title="Minimize / Restore">▢</button>
        <button id="closeBtn" title="Close">×</button>
        </div>
      </div>
      <div class="body">
        <div class="grid">
          <label>start Tl X<input id="startBlockX" type="number" value="0"></label>
          <label>start Tl Y<input id="startBlockY" type="number" value="0"></label>
          <label>start Px X<input id="startX" type="number" value="652"></label>
          <label>start Px Y<input id="startY" type="number" value="964"></label>
          <label>end Tl X<input id="endBlockX" type="number" value="0"></label>
          <label>end Tl Y<input id="endBlockY" type="number" value="1"></label>
          <label>end Px X<input id="endX" type="number" value="670"></label>
          <label>end Px Y<input id="endY" type="number" value="23"></label>
          <label>step X<input id="stepX" type="number" value="1" min="1"></label>
          <label>step Y<input id="stepY" type="number" value="1" min="1"></label>
          <div style="grid-column:1 / -1; margin-top:8px; border-top:1px solid #eee; padding-top:8px;">
            <button id="advToggle" type="button">Show advanced ▾</button>
            <div id="advBody" style="margin-top:8px; display:none;">
            <div class="adv-grid-responsive">
                <label>CONCURRENCY <input id="CONCURRENCY" type="number" value="4" min="1"></label>
                <label>MAX_RPS <input id="MAX_RPS" type="number" value="6" min="1"></label>
                <label>BATCH_SIZE <input id="BATCH_SIZE" type="number" value="10" min="1"></label>
                <label>BATCH_DELAY_MINUTES <input id="BATCH_DELAY_MINUTES" type="number" value="0.05" step="0.001" min="0"></label>
                <label>BASE_TEMPLATE <input id="BASE_TEMPLATE" type="text" placeholder="Default"></label>
                <label style="grid-column: 1 / -1;"></label>
            </div>
            </div>
          </div>
        </div>

        <div class="controls" style="margin-top:10px;">
          <button id="pickStartBtn" type="button">Pick start</button>
          <button id="pickEndBtn" type="button">Pick end</button>
          <button id="startBtn">Start</button>
          <button id="stopBtn" disabled>Stop</button>
          <button id="clearBtn">Clear Log</button>
        </div>

        <div id="log" class="log" aria-live="polite"></div>
      </div>
    </div>
  `;

  // attach to shadow
  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html;
  shadow.appendChild(styleEl);
  shadow.appendChild(wrapper);

  document.documentElement.appendChild(host);

  // helpers to access shadow DOM nodes
  function $id(id) { return shadow.querySelector('#' + id); }

  // UI elements
  const panelRoot = $id('panelRoot');
  const header = $id('header');
  const minBtn = $id('minBtn');
  const closeBtn = $id('closeBtn');
  const advToggle = $id('advToggle');
  const advBody = $id('advBody');
  const startBtn = $id('startBtn');
  const stopBtn = $id('stopBtn');
  const clearBtn = $id('clearBtn');
  const pickStartBtn = $id('pickStartBtn');
  const pickEndBtn = $id('pickEndBtn');
  const logEl = $id('log');

  // fields map
  const fields = ['startBlockX','startBlockY','startX','startY','endBlockX','endBlockY','endX','endY','stepX','stepY','CONCURRENCY','MAX_RPS','BATCH_SIZE','BATCH_DELAY_MINUTES','BASE_TEMPLATE'];
  const inputs = {};
  fields.forEach(f => inputs[f] = $id(f));

  // state
  let minimized = false;

  function log(type, text, extra) {
    try {
      if (!logEl) return;
      const p = document.createElement('div');
      p.className = type || 'info';
      const time = new Date().toLocaleTimeString();
      p.textContent = `[${time}] ${text}` + (extra ? ` ${JSON.stringify(extra)}` : '');
      logEl.appendChild(p);
      logEl.scrollTop = logEl.scrollHeight;
    } catch (e) {}
    if (type === 'error') console.error(text, extra || '');
    else if (type === 'warn') console.warn(text, extra || '');
    else console.log(text, extra || '');
  }

  // minimize/restore toggle + close (robust: logs, pointer handlers, pointerEvents forced)
  const minToggle = shadow.querySelector('#minBtn'); // 保持 id 不变
  const panelBody = shadow.querySelector('.body');
  let isMin = false;

  // debug log to check element presence when script runs
  console.log('[WPI] binding minToggle', !!minToggle, !!panelBody, !!panelRoot);

  if (minToggle) {
    // ensure the button can receive pointer events even if some page CSS tries to block
    try { minToggle.style.pointerEvents = 'auto'; minToggle.tabIndex = 0; } catch(e){}

    function doToggle(e) {
      try {
        e && e.stopPropagation();
        isMin = !isMin;
        if (isMin) {
          if (panelBody) panelBody.classList.add('hidden');
          if (panelRoot) {
            panelRoot.style.width = '260px';
            panelRoot.style.height = '48px';
            panelRoot.classList.add('mini');
          }
          minToggle.textContent = '▣';
          minToggle.title = 'Restore';
        } else {
          if (panelBody) panelBody.classList.remove('hidden');
          if (panelRoot) {
            panelRoot.style.width = '';
            panelRoot.style.height = '560px';
            panelRoot.classList.remove('mini');
          }
          minToggle.textContent = '▢';
          minToggle.title = 'Minimize';
        }
        console.log('[WPI] minToggle clicked, isMin=', isMin);
      } catch (err) { console.error('[WPI] minToggle handler error', err); }
    }

    // attach both click and pointerup to increase reliability across pages
    minToggle.addEventListener('click', doToggle, { passive: true });
    minToggle.addEventListener('pointerup', doToggle, { passive: true });

    // also listen keyboard (Enter / Space) for accessibility testing
    minToggle.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); doToggle(ev); }
    });

  } else {
    console.warn('[WPI] minToggle not found in shadow DOM');
  }

  // close button: remove panel
  // close button: remove panel and quick button, clear injected flag
if (closeBtn) {
  closeBtn.addEventListener('click', () => {
    try {
      // remove panel host if present
      try { if (host && host.parentElement) host.remove(); } catch(e){}
      // remove quick open button if present (id = wpi-quick-btn)
      try {
        const existingQuick = document.getElementById && document.getElementById('wpi-quick-btn');
        if (existingQuick && existingQuick.parentElement) existingQuick.remove();
      } catch(e){}
      // clear injected marker so future injection (e.g., extension reload) can run cleanly
      try { window.__WPI_PANEL_INJECTED__ = false; } catch(e){}
      console.log('[WPI] closed all UI');
    } catch(e) {
      console.error('[WPI] closeBtn handler error', e);
    }
  });
}

  // advanced toggle
  if (advToggle && advBody) {
    advToggle.addEventListener('click', (e) => {
      const isOpen = advBody.style.display !== 'none';
      if (isOpen) { advBody.style.display = 'none'; advToggle.textContent = 'Show advanced ▾'; }
      else { advBody.style.display = 'block'; advToggle.textContent = 'Hide advanced ▴'; }
    });
  }

  // drag support
  (function(){
    let dragging = false, startX=0, startY=0, origLeft=0, origTop=0;
    header.addEventListener('pointerdown', e => {
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      const rect = host.getBoundingClientRect();
      origLeft = rect.left; origTop = rect.top;
      header.setPointerCapture && header.setPointerCapture(e.pointerId);
    });
    header.addEventListener('pointermove', e => {
      if (!dragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      host.style.left = (origLeft + dx) + 'px';
      host.style.top = (origTop + dy) + 'px';
      host.style.right = 'auto';
      host.style.bottom = 'auto';
    });
    header.addEventListener('pointerup', e => { dragging = false; });
    header.addEventListener('pointercancel', e => { dragging = false; });
  })();

  // storage helpers (use chrome.storage.local to persist)
  function storageSet(key, val) {
    try { chrome.storage.local.set({ [key]: val }); }
    catch(e){}
  }
  function storageGet(key) {
    return new Promise(resolve => {
      try { chrome.storage.local.get([key], res => resolve(res ? res[key] : undefined)); }
      catch (e) { resolve(undefined); }
    });
  }

  // collect UI settings
  function collectSettingsFromUI() {
    try {
      const cfg = {};
      fields.forEach(f => {
        const el = inputs[f];
        if (!el) return;
        if (el.type === 'number') cfg[f] = Number(el.value || 0);
        else cfg[f] = (el.value || '').toString();
      });
      cfg.stepX = Math.max(1, Number(cfg.stepX || 1));
      cfg.stepY = Math.max(1, Number(cfg.stepY || 1));
      return cfg;
    } catch (e) { return {}; }
  }

  // apply picked coords (call content.js via chrome.runtime.sendMessage)
  async function pickCoordsFromPage() {
  // try direct DOM parse first
  try {
    const el = document.getElementById('bm-h') || document.querySelector('[id="bm-h"]');
    const raw = el ? (el.innerText || el.textContent || '') : '';
    const coords = parseBmH(raw);
    if (coords) return { ok: true, coords };
    // if parse failed, fall through to message fallback
  } catch (e) {
    // ignore and try message fallback
  }

  // fallback: ask content script / page-injected parser via runtime message
  try {
    return await new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type: 'grabCoords' }, resp => {
          resolve(resp || { ok: false, error: 'no-response' });
        });
      } catch (err) {
        resolve({ ok: false, error: String(err) });
      }
    });
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

  async function applyPickedCoords(kind) {
    try {
      const res = await pickCoordsFromPage();
      if (!res || !res.ok) { log('error', `Pick ${kind} failed`, res); return; }
      const c = res.coords;
      if (!c) { log('error', `Pick ${kind} parse failed`, res); return; }
      if (kind === 'start') {
        if (inputs.startBlockX) inputs.startBlockX.value = String(c.tlX || 0);
        if (inputs.startBlockY) inputs.startBlockY.value = String(c.tlY || 0);
        if (inputs.startX) inputs.startX.value = String(c.pxX || 0);
        if (inputs.startY) inputs.startY.value = String(c.pxY || 0);
        log('info','Picked start coords', c);
      } else {
        if (inputs.endBlockX) inputs.endBlockX.value = String(c.tlX || 0);
        if (inputs.endBlockY) inputs.endBlockY.value = String(c.tlY || 0);
        if (inputs.endX) inputs.endX.value = String(c.pxX || 0);
        if (inputs.endY) inputs.endY.value = String(c.pxY || 0);
        log('info','Picked end coords', c);
      }
      // persist settings locally
      storageSet('pxf_settings', collectSettingsFromUI());
    } catch (e) { log('error','applyPickedCoords error', String(e)); }
  }

  // wire pick buttons
  if (pickStartBtn) pickStartBtn.addEventListener('click', async () => { pickStartBtn.disabled = true; try { await applyPickedCoords('start'); } finally { pickStartBtn.disabled = false; } });
  if (pickEndBtn) pickEndBtn.addEventListener('click', async () => { pickEndBtn.disabled = true; try { await applyPickedCoords('end'); } finally { pickEndBtn.disabled = false; } });

  // start / stop handlers -> call background messages (start-fetch / stop-fetch)
  if (startBtn) startBtn.addEventListener('click', async () => {
    startBtn.disabled = true; if (stopBtn) stopBtn.disabled = false;
    const cfg = collectSettingsFromUI();
    log('info','Starting job via background', { summary:`blocks ${cfg.startBlockX},${cfg.startBlockY} -> ${cfg.endBlockX},${cfg.endBlockY}` });
    // clear stop flag
    try { chrome.storage.local.remove('__PIXEL_FETCHER_STOP__'); } catch (e){}
    // send start-fetch to background
    chrome.runtime.sendMessage({ type: 'start-fetch', cfg }, resp => {
      if (resp && resp.ok) {
        storageSet('__PXF_RUNNING__', { running:true, startedAt: Date.now(), cfg });
        log('info','Background accepted start', { jobId: resp.jobId });
      } else if (resp && resp.error === 'already-running') {
        log('warn','Start rejected: already-running. Try stop then retry.');
        // request background stop then retry
        chrome.runtime.sendMessage({ type: 'stop-fetch' }, stopResp => {
          setTimeout(() => {
            chrome.runtime.sendMessage({ type: 'start-fetch', cfg }, r2 => {
              if (r2 && r2.ok) {
                storageSet('__PXF_RUNNING__', { running:true, startedAt: Date.now(), cfg });
                log('info','Background accepted start (retry)', { jobId: r2.jobId });
              } else {
                log('error','Start failed after retry', r2);
                startBtn.disabled = false; if (stopBtn) stopBtn.disabled = true;
              }
            });
          }, 800);
        });
      } else {
        log('error','Background start failed', resp);
        startBtn.disabled = false; if (stopBtn) stopBtn.disabled = true;
      }
    });
  });

  if (stopBtn) stopBtn.addEventListener('click', async () => {
    stopBtn.disabled = true;
    try { await chrome.storage.local.set({'__PIXEL_FETCHER_STOP__':'1'}); } catch(e){}
    chrome.runtime.sendMessage({ type: 'stop-fetch' }, resp => {
      if (resp && resp.ok) {
        log('info','Stop acknowledged by background');
        storageSet('__PXF_RUNNING__', null);
        try { chrome.storage.local.remove('__PXF_JOB_STORE__'); } catch(e){}
      } else {
        log('warn','Background stop may have failed', resp);
        stopBtn.disabled = false;
      }
    });
  });

  if (clearBtn) clearBtn.addEventListener('click', () => { if (logEl) logEl.innerHTML = ''; });

  // load persisted settings into inputs on init
  (async function loadSettings(){
    try {
      const s = await storageGet('pxf_settings');
      const cfg = s || {};
      fields.forEach(f => { if (cfg[f] != null && inputs[f]) inputs[f].value = String(cfg[f]); });
    } catch (e) {}
  })();

  // poll progress and recent events to update UI/logs (reuse your storage keys)
  let pollSeen = new Set();
  async function pollProgressAndEvents() {
    try {
      const pRaw = await storageGet('__PXF_PROGRESS__');
      const progress = pRaw || null;
      if (progress) {
        const key = JSON.stringify({ done: progress.done, total: progress.total, ts: progress.timestamp || '' }).slice(0,200);
        if (!pollSeen.has(key)) {
          pollSeen.add(key);
          if (progress.lastBatch) {
            const lb = progress.lastBatch;
            log('info', `Batch ${lb.batchStartIndex}→${lb.batchEndIndex} (${lb.batchCount})`, { durationMs: lb.batchDurationMs });
          } else {
            log('info', `Progress ${progress.done}/${progress.total}`, progress);
          }
          if (progress.finished || progress.stopped) {
            // update UI state
            try { chrome.storage.local.remove('__PXF_RUNNING__'); } catch(e){}
            if (startBtn) startBtn.disabled = false;
            if (stopBtn) stopBtn.disabled = true;
          }
        }
      }
      // recent events from main.js
      chrome.runtime.sendMessage({ type:'get-recent-events' }, resp => {
        try {
          if (resp && resp.recent && Array.isArray(resp.recent)) {
            resp.recent.forEach(ev => {
              const p = ev.payload || {};
              const key = (ev.time||'') + '|' + (p.evt||'') + '|' + (p.text||'');
              if (!pollSeen.has(key)) {
                pollSeen.add(key);
                log('info', (p.evt||'evt') + ' ' + (p.text||''), p);
                if (p.evt === 'done' || (p.evt === 'run-state' && p.running === false)) {
                  if (startBtn) startBtn.disabled = false;
                  if (stopBtn) stopBtn.disabled = true;
                }
              }
            });
          }
        } catch(e){}
      });
    } catch (e) {}
  }
  const pollInterval = setInterval(pollProgressAndEvents, 1200);
  pollProgressAndEvents();

  // respond to background toggle request
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'TOGGLE_PANEL') {
      try {
        if (!host.parentElement) document.documentElement.appendChild(host);
        host.style.display = (host.style.display === 'none' ? '' : '');
      } catch (e) {}
    }
  });

  // when storage stop flag set elsewhere, update UI
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes && changes['__PXF_RUNNING__']) {
      const nv = changes['__PXF_RUNNING__'].newValue;
      const running = !!(nv && nv.running);
      if (running) { if (startBtn) startBtn.disabled = true; if (stopBtn) stopBtn.disabled = false; }
      else { if (startBtn) startBtn.disabled = false; if (stopBtn) stopBtn.disabled = true; }
    }
    if (changes && changes['__PIXEL_FETCHER_STOP__']) {
      const v = changes['__PIXEL_FETCHER_STOP__'].newValue;
      if (v === '1' || v === 1 || v === true || v === 'true') {
        if (startBtn) startBtn.disabled = false;
        if (stopBtn) stopBtn.disabled = true;
        log('info','Detected stop flag set');
      }
    }
  });

  // cleanup on page unload
  window.addEventListener('beforeunload', () => {
    try { clearInterval(pollInterval); } catch(e){}
  });

    // draggable quick open button: single visible control to toggle / minimize / restore panel
    const quickBtn = document.createElement('button');
    quickBtn.textContent = 'WPI';
    quickBtn.id = 'wpi-quick-btn';

    // requested base style
    Object.assign(quickBtn.style, {
    position: 'fixed',
    right: '20px',
    bottom: '20px',
    zIndex: '2147483646',
    padding: '8px 10px',
    borderRadius: '6px',
    background: 'rgb(25, 118, 210)',
    color: 'rgb(255, 255, 255)',
    border: 'none',
    cursor: 'pointer',
    pointerEvents: 'auto',
    userSelect: 'none',
    touchAction: 'none'
    });

    // helpers to query panel state
    function isPanelHidden() {
    try { return !host.parentElement || host.style.display === 'none' || getComputedStyle(host).display === 'none'; } catch(e){ return true; }
    }
    function isPanelMinimized() {
    try {
        const body = shadow.querySelector('.body');
        return body && body.classList.contains('hidden');
    } catch(e){ return false; }
    }
    function showPanelFull() {
    try {
        if (!host.parentElement) document.documentElement.appendChild(host);
        const body = shadow.querySelector('.body');
        if (body) body.classList.remove('hidden');
        if (panelRoot) { panelRoot.style.width = ''; panelRoot.style.height = '560px'; panelRoot.classList.remove('mini'); }
        host.style.display = '';
    } catch(e){ console.error('[WPI] showPanelFull err', e); }
    }
    function minimizePanel() {
    try {
        const body = shadow.querySelector('.body');
        if (body) body.classList.add('hidden');
        if (panelRoot) { panelRoot.style.width = '260px'; panelRoot.style.height = '48px'; panelRoot.classList.add('mini'); }
    } catch(e){ console.error('[WPI] minimizePanel err', e); }
    }
    function restorePanelFromMin() {
    try {
        const body = shadow.querySelector('.body');
        if (body) body.classList.remove('hidden');
        if (panelRoot) { panelRoot.style.width = ''; panelRoot.style.height = '560px'; panelRoot.classList.remove('mini'); }
    } catch(e){ console.error('[WPI] restorePanelFromMin err', e); }
    }

    // click logic for the quick button:
    // - if panel hidden -> show full panel
    // - else if panel visible and not minimized -> minimize
    // - else if panel minimized -> restore to full
    let quickDragMoved = false;
    quickBtn.addEventListener('click', (ev) => {
    try {
        if (quickDragMoved) { quickDragMoved = false; return; }
        if (isPanelHidden()) { showPanelFull(); return; }
        if (!isPanelMinimized()) { minimizePanel(); }
        else { restorePanelFromMin(); }
    } catch (e) { console.error('[WPI] quickBtn click err', e); }
    }, { passive: true });

    // draggable behavior using pointer events
    let draggingQuick = false;
    let dragStartX = 0, dragStartY = 0;
    let origRight = 20, origBottom = 20;

    quickBtn.addEventListener('pointerdown', (e) => {
    try {
        draggingQuick = true;
        quickDragMoved = false;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        const comp = window.getComputedStyle(quickBtn);
        origRight = parseFloat(comp.right || '20') || 20;
        origBottom = parseFloat(comp.bottom || '20') || 20;
        quickBtn.setPointerCapture && quickBtn.setPointerCapture(e.pointerId);
    } catch (err) { console.warn('[WPI] quickBtn pointerdown', err); }
    });

    quickBtn.addEventListener('pointermove', (e) => {
    if (!draggingQuick) return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    const newRight = Math.max(8, origRight - dx);
    const newBottom = Math.max(8, origBottom - dy);
    quickBtn.style.right = `${newRight}px`;
    quickBtn.style.bottom = `${newBottom}px`;
    quickDragMoved = true;
    });

    function quickEndDrag(e) {
    if (!draggingQuick) return;
    draggingQuick = false;
    try { e && quickBtn.releasePointerCapture && quickBtn.releasePointerCapture(e.pointerId); } catch (err) {}
    setTimeout(() => { quickDragMoved = false; }, 160);
    }
    quickBtn.addEventListener('pointerup', quickEndDrag, { passive: true });
    quickBtn.addEventListener('pointercancel', quickEndDrag, { passive: true });

    // append and ensure initial state
    document.documentElement.appendChild(quickBtn);
    try { host.style.display = 'none'; } catch(e){}
})();
