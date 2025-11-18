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

  // style + html
  const css = `
    :host { all: initial; }
    *, *::before, *::after {
      box-sizing: border-box;
      font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial;
    }
    .coord-rowset {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-bottom: 12px;
    }
    .coord-row {
      display: grid;
      grid-template-columns: auto repeat(4, minmax(0, 1fr));
      gap: 8px;
      align-items: flex-end;
    }
    .coord-tag {
      font-size: 12px;
      font-weight: 600;
      padding: 6px 12px;
      border-radius: 16px;
      background: rgba(160,184,239,0.15);
      border: 1px solid rgba(160,184,239,0.3);
      color: #A0B8EF;
      letter-spacing: 0.8px;
      text-transform: uppercase;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px 18px;
      margin-top: 6px;
    }
    .panel {
      position: relative;
      z-index: 0;
      display: flex;
      flex-direction: column;
      width: 480px;
      max-width: calc(100vw - 32px);
      max-height: 580px;
      background: rgba(255,255,255,0.04);
      color: #FEF4F4;
      border-radius: 22px;
      box-shadow: 0 25px 45px rgba(0,0,0,0.4);
      overflow: hidden;
      border: 1px solid rgba(255,255,255,0.12);
      backdrop-filter: blur(22px);
    }
    .panel::before {
      content: '';
      position: absolute;
      inset: 0;
      background: #2F3333;
      z-index: -1;
    }
    .coord-row label {
      font-size: 11px;
      gap: 4px;
    }
    .header {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: flex-start;
      padding: 8px 12px;
      min-height: 44px;
      border-bottom: 1px solid rgba(255,255,255,0.08);
      cursor: grab;
      background: rgba(47,51,51,0.95);
    }
    .title {
      position: absolute;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      font-size: 14px;
      font-weight: 600;
      letter-spacing: 0.4px;
      max-width: calc(100% - 140px);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      pointer-events: none;
    }
    .header .controls {
      margin-left: auto;
      display: flex;
      gap: 8px;
      align-items: center;
    }
    #minBtn {
      border: none;
      background: rgba(255,255,255,0.08);
      padding: 6px 10px;
      color: #FEF4F4;
      font-size: 14px;
      line-height: 1;
      border-radius: 12px;
      cursor: pointer;
      transition: background 0.2s ease, transform 0.2s ease;
      backdrop-filter: blur(10px);
    }
    #minBtn:hover { background: rgba(255,255,255,0.14); transform: translateY(-1px); }
    #minBtn:focus { outline: 2px solid rgba(160,184,239,0.45); outline-offset: 2px; }

    .body {
      padding: 14px;
      overflow: auto;
      flex: 1;
      background: rgba(255,255,255,0.02);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px 18px;
    }
    label {
      font-size: 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      color: #FEF4F4;
    }
    input[type="number"], input[type="text"] {
      padding: 10px 12px;
      font-size: 13px;
      border: 1px solid rgba(255,255,255,0.18);
      border-radius: 16px;
      background: rgba(255,255,255,0.08);
      color: #FEF4F4;
      outline: none;
      backdrop-filter: blur(14px);
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
    }
    input[type="number"] {
      padding-right: 38px;
      appearance: textfield;
      -moz-appearance: textfield;
    }
    .coord-row input[type="number"] {
      padding: 6px 8px;
      padding-right: 38px;
      font-size: 12px;
    }
    input[type="number"]:focus, input[type="text"]:focus {
      border-color: #A0B8EF;
      box-shadow: 0 0 0 2px rgba(160,184,239,0.25);
    }
    input[type="number"]::-webkit-inner-spin-button,
    input[type="number"]::-webkit-outer-spin-button {
      -webkit-appearance: none;
      margin: 0;
    }
    .num-input-wrap {
      position: relative;
      width: 100%;
    }
    .num-input-wrap input[type="number"] { width: 100%; }
    .spinner-overlay {
      position: absolute;
      top: 4px;
      right: 4px;
      bottom: 4px;
      width: 28px;
      border-left: 1px solid rgba(255,255,255,0.12);
      border-radius: 10px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: rgba(255,255,255,0.02);
      backdrop-filter: blur(10px);
    }
    .coord-row .spinner-overlay {
      top: 2px;
      bottom: 2px;
      border-radius: 8px;
    }
    .spinner-btn {
      flex: 1;
      border: 0;
      background: transparent;
      cursor: pointer;
      color: #F0F6FF;
      font-size: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      line-height: 1;
      padding: 0;
      transition: background 0.15s ease, color 0.15s ease;
      user-select: none;
    }
    .spinner-btn + .spinner-btn {
      border-top: 1px solid rgba(255,255,255,0.08);
    }
    .spinner-btn:hover {
      background: rgba(160,184,239,0.18);
      color: #ffffff;
    }
    .spinner-btn:active {
      background: rgba(160,184,239,0.28);
    }
    .spinner-btn:focus {
      outline: 1px solid rgba(160,184,239,0.5);
      outline-offset: -2px;
    }
    .controls {
      display:flex;
      gap:10px;
      margin:12px 0;
      flex-wrap:wrap;
    }
    button {
      padding:10px 16px;
      font-size:13px;
      border-radius:18px;
      border:none;
      background:#A0B8EF;
      color:#1e1f2b;
      cursor:pointer;
      font-weight:600;
      box-shadow:0 12px 24px rgba(160,184,239,0.35);
      transition:transform 0.18s ease, box-shadow 0.18s ease, opacity 0.2s ease;
    }
    button:hover:not(:disabled) {
      transform: translateY(-1px);
      box-shadow:0 14px 28px rgba(160,184,239,0.45);
    }
    button:disabled { opacity:0.45; cursor:not-allowed; box-shadow:none; }
    .log {
      height:200px;
      overflow:auto;
      background:rgba(0,0,0,0.4);
      color:#FEF4F4;
      padding:12px;
      font-family:monospace;
      font-size:12px;
      border-radius:18px;
      border:1px solid rgba(255,255,255,0.08);
      backdrop-filter:blur(14px);
    }
    .log .info { color:#A0B8EF; }
    .log .warn { color:#F8E58C; }
    .log .error { color:#FF9A9A; }
    .panel,
    .body,
    .log {
      scrollbar-color: rgba(160,184,239,0.6) transparent;
      scrollbar-width: thin;
    }
    ::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }
    ::-webkit-scrollbar-track {
      background: rgba(255,255,255,0.05);
      border-radius: 999px;
    }
    ::-webkit-scrollbar-thumb {
      background: linear-gradient(180deg, rgba(255,255,255,0.22), rgba(160,184,239,0.65));
      border-radius: 999px;
      border: 1px solid rgba(47,51,51,0.6);
    }
    ::-webkit-scrollbar-thumb:hover {
      background: linear-gradient(180deg, rgba(255,255,255,0.35), rgba(160,184,239,0.8));
    }
    .hidden { display:none; }
    .mini {
      width:260px;
      height:48px;
      border-radius:16px;
      display:flex;
      align-items:center;
      justify-content:center;
      font-weight:600;
      background:rgba(47,51,51,0.9);
      color:#FEF4F4;
      border:1px solid rgba(255,255,255,0.12);
    }
    #advToggle {
      border:none;
      background:rgba(255,255,255,0.08);
      color:#FEF4F4;
      padding:8px 12px;
      border-radius:14px;
      cursor:pointer;
      backdrop-filter:blur(10px);
      transition:background 0.2s ease, transform 0.2s ease;
    }
    #advToggle:hover { background: rgba(255,255,255,0.16); transform: translateY(-1px); }
    .grid-span {
      grid-column: 1 / -1;
      margin-top: 8px;
      border-top: 1px solid rgba(255,255,255,0.12);
      padding-top: 8px;
    }
    .adv-flex {
      display: flex;
      gap: 12px;
      align-items: center;
      flex-wrap: wrap;
    }
    .base-template {
      flex: 1;
      min-width: 200px;
    }
    .base-template input { width: 100%; }
  `;

  const html = `
    <div class="panel" id="panelRoot">
      <div class="header" id="header">
        <div class="title">          Wplace_Map_Inspector</div>
        <div class="controls">
          <button id="minBtn" type="button" title="Minimize / Restore" tabindex="0">—</button>
        </div>
      </div>
      <div class="body">
        <div class="coord-rowset">
          <div class="coord-row">
            <span class="coord-tag">Start</span>
            <label>Tl X<input id="startBlockX" type="number" value="0"></label>
            <label>Tl Y<input id="startBlockY" type="number" value="0"></label>
            <label>Px X<input id="startX" type="number" value="652"></label>
            <label>Px Y<input id="startY" type="number" value="964"></label>
          </div>
          <div class="coord-row">
            <span class="coord-tag">End</span>
            <label>Tl X<input id="endBlockX" type="number" value="0"></label>
            <label>Tl Y<input id="endBlockY" type="number" value="1"></label>
            <label>Px X<input id="endX" type="number" value="670"></label>
            <label>Px Y<input id="endY" type="number" value="23"></label>
          </div>
        </div>
        <div class="grid">
          <label>step X<input id="stepX" type="number" value="1" min="1"></label>
          <label>step Y<input id="stepY" type="number" value="1" min="1"></label>
          <div class="grid-span">
            <button id="advToggle" type="button">Show advanced ▾</button>
            <div id="advBody" style="margin-top:8px; display:none;">
              <div class="adv-flex">
                <label>CONCURRENCY <input id="CONCURRENCY" type="number" value="4" min="1"></label>
                <label>MAX_RPS <input id="MAX_RPS" type="number" value="6" min="1"></label>
                <label>BATCH_SIZE <input id="BATCH_SIZE" type="number" value="10" min="1"></label>
                <label>BATCH_DELAY_MINUTES <input id="BATCH_DELAY_MINUTES" type="number" value="0.045" step="0.001" min="0"></label>
                <label class="base-template">BASE_TEMPLATE <input id="BASE_TEMPLATE" type="text" placeholder="Default"></label>
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

  // log helper
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

  // QUICK BUTTON (blue) - create early and ensure stable presence when needed
  const quickBtnId = 'wpi-quick-btn';
  function createQuickBtn() {
    let existing = document.getElementById(quickBtnId);
    if (existing) return existing;
    const btn = document.createElement('button');
    btn.textContent = 'WPI';
    btn.id = quickBtnId;
    Object.assign(btn.style, {
      position: 'fixed',
      right: '20px',
      bottom: '20px',
      zIndex: '2147483646',
      padding: '10px 16px',
      borderRadius: '16px',
      background: '#A0B8EF',
      color: '#1e1f2b',
      border: 'none',
      boxShadow: '0 14px 26px rgba(160,184,239,0.45)',
      cursor: 'pointer',
      pointerEvents: 'auto',
      userSelect: 'none',
      touchAction: 'none'
    });
    document.documentElement.appendChild(btn);
    // bind handlers every time we create a button
    bindQuickBtnHandlers(btn);
    return btn;
  }

  // bind/unbind quick button handlers (safe to re-bind)
  function bindQuickBtnHandlers(btn) {
    if (!btn) return;
    // remove previous handlers if any
    btn.onclick = null;
    btn.onpointerdown = null;
    btn.onpointermove = null;
    btn.onpointerup = null;
    btn.onpointercancel = null;

    // state for drag detection
    let draggingQuick = false;
    let dragStartX = 0, dragStartY = 0;
    let origRight = 20, origBottom = 20;
    let movedSinceDown = false;

    btn.addEventListener('pointerdown', (e) => {
      draggingQuick = true;
      movedSinceDown = false;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      const comp = window.getComputedStyle(btn);
      origRight = parseFloat(comp.right || '20') || 20;
      origBottom = parseFloat(comp.bottom || '20') || 20;
      try { btn.setPointerCapture && btn.setPointerCapture(e.pointerId); } catch (err) {}
      e.stopPropagation();
    });

    btn.addEventListener('pointermove', (e) => {
      if (!draggingQuick) return;
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      const newRight = Math.max(8, origRight - dx);
      const newBottom = Math.max(8, origBottom - dy);
      btn.style.right = `${newRight}px`;
      btn.style.bottom = `${newBottom}px`;
      movedSinceDown = true;
    });

    // pointerup will end drag; we set a short flag to ignore the subsequent click if it immediately follows
    btn.addEventListener('pointerup', (e) => {
      if (!draggingQuick) return;
      draggingQuick = false;
      try { btn.releasePointerCapture && btn.releasePointerCapture(e.pointerId); } catch (err) {}
      // If it was a drag, set a small timeout to suppress the next click event
      if (movedSinceDown) {
        btn.__suppressNextClick = true;
        setTimeout(() => { btn.__suppressNextClick = false; }, 150);
      }
      movedSinceDown = false;
      e.stopPropagation();
    });

    btn.addEventListener('pointercancel', (e) => {
      draggingQuick = false;
      movedSinceDown = false;
      try { btn.releasePointerCapture && btn.releasePointerCapture(e.pointerId); } catch (err) {}
    });

    btn.addEventListener('click', (ev) => {
      // ignore clicks generated by a drag
      if (btn.__suppressNextClick) { btn.__suppressNextClick = false; return; }
      quickClickHandler(ev);
    }, true);
  }

  // ensure quick button exists and is bound
  let quickBtn = createQuickBtn();

  // state helpers for panel
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
  function minimizePanelInsideHost() {
    try {
      const body = shadow.querySelector('.body');
      if (body) body.classList.add('hidden');
      if (panelRoot) { panelRoot.style.width = '260px'; panelRoot.style.height = '48px'; panelRoot.classList.add('mini'); }
      host.style.display = '';
    } catch(e){ console.error('[WPI] minimizePanelInsideHost err', e); }
  }
  function restorePanelFromMin() {
    try {
      const body = shadow.querySelector('.body');
      if (body) body.classList.remove('hidden');
      if (panelRoot) { panelRoot.style.width = ''; panelRoot.style.height = '560px'; panelRoot.classList.remove('mini'); }
      host.style.display = '';
    } catch(e){ console.error('[WPI] restorePanelFromMin err', e); }
  }
  function hidePanelAndKeepQuick() {
    try {
      host.style.display = 'none';
      // ensure quick button exists and is bound
      quickBtn = createQuickBtn();
    } catch(e){ console.error('[WPI] hidePanelAndKeepQuick err', e); }
  }
  function restoreFromQuick() {
    try {
      if (!host.parentElement) document.documentElement.appendChild(host);
      showPanelFull();
      const ex = document.getElementById(quickBtnId);
      if (ex && ex.parentElement) ex.parentElement.removeChild(ex);
      // re-create and bind a fresh quickBtn reference for future use
      quickBtn = createQuickBtn();
    } catch(e){ console.error('[WPI] restoreFromQuick err', e); }
  }

  // initial state: show quickBtn and hide host
  try { host.style.display = 'none'; } catch(e){}

  // ensure pointer events and keyboard accessible for minBtn
  if (minBtn) {
    try { minBtn.style.pointerEvents = 'auto'; minBtn.tabIndex = 0; } catch(e){}
    const handleMin = (ev) => {
      try {
        ev && ev.stopPropagation && ev.stopPropagation();
        // If panel currently hidden (user clicked quick button area to bring up panel earlier), restore
        if (isPanelHidden()) {
          restoreFromQuick();
          if (minBtn) { minBtn.textContent = '—'; minBtn.title = 'Minimize'; }
          return;
        }
        const body = shadow.querySelector('.body');
        const currentlyMin = body && body.classList.contains('hidden');
        if (!currentlyMin) {
          // not minimized => minimize inside host
          minimizePanelInsideHost();
          if (minBtn) { minBtn.textContent = '▣'; minBtn.title = 'Restore'; }
        } else {
          // already minimized => hide host and keep quick button
          hidePanelAndKeepQuick();
          if (minBtn) { minBtn.textContent = '▣'; minBtn.title = 'Restore (click WPI)'; }
        }
      } catch(err) { console.error('[WPI] minBtn handler err', err); }
    };
    minBtn.addEventListener('click', handleMin);
    minBtn.addEventListener('pointerup', handleMin);
    minBtn.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); handleMin(ev); } });
  }

  // quickClickHandler (kept separate)
  function quickClickHandler(ev) {
    try {
      // requery quickBtn in case element was re-created
      const qb = document.getElementById(quickBtnId);
      if (qb && qb.__suppressNextClick) { qb.__suppressNextClick = false; return; }
      if (isPanelHidden()) {
        showPanelFull();
        const existing = document.getElementById(quickBtnId);
        if (existing && existing.parentElement) existing.parentElement.removeChild(existing);
        if (minBtn) { minBtn.textContent = '—'; minBtn.title = 'Minimize'; }
        return;
      }
      if (!isPanelMinimized()) {
        minimizePanelInsideHost();
        if (minBtn) { minBtn.textContent = '▣'; minBtn.title = 'Restore'; }
      } else {
        restorePanelFromMin();
        const existing = document.getElementById(quickBtnId);
        if (existing && existing.parentElement) existing.parentElement.removeChild(existing);
        if (minBtn) { minBtn.textContent = '—'; minBtn.title = 'Minimize'; }
      }
    } catch(e) { console.error('[WPI] quickBtn click err', e); }
  }

  // advanced toggle
  if (advToggle && advBody) {
    advToggle.addEventListener('click', (e) => {
      const isOpen = advBody.style.display !== 'none';
      if (isOpen) { advBody.style.display = 'none'; advToggle.textContent = 'Show advanced ▾'; }
      else { advBody.style.display = 'block'; advToggle.textContent = 'Hide advanced ▴'; }
    });
  }

  // panel drag support — only start dragging when user targets the header itself, not its controls
  (function(){
    let dragging = false, startX=0, startY=0, origLeft=0, origTop=0;
    header.addEventListener('pointerdown', e => {
      const ctrl = header.querySelector('.controls');
      if (ctrl && ctrl.contains(e.target)) return;
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      const rect = host.getBoundingClientRect();
      origLeft = rect.left; origTop = rect.top;
      try { header.setPointerCapture && header.setPointerCapture(e.pointerId); } catch(e){}
      e.stopPropagation();
    });
    header.addEventListener('pointermove', e => {
      if (!dragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      host.style.left = (origLeft + dx) + 'px';
      host.style.top = (origTop + dy) + 'px';
      host.style.right = 'auto';
      host.style.bottom = 'auto';
    });
    header.addEventListener('pointerup', e => { dragging = false; try { header.releasePointerCapture && header.releasePointerCapture(e.pointerId); } catch(e){} });
    header.addEventListener('pointercancel', e => { dragging = false; try { header.releasePointerCapture && header.releasePointerCapture(e.pointerId); } catch(e){} });
  })();

  // storage helpers
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

  // --- helper for total estimate: normalize block+pixel like injector uses ---
  const UI_BLOCK_SIZE = 1000; // match inject script default
  function normalizeBlockPixelUI(blockX, blockB, pxX, pxY, BLOCK_SIZE) {
    let bx = Number(blockX) || 0;
    let by = Number(blockB) || 0;
    let px = Number(pxX) || 0;
    let py = Number(pxY) || 0;
    if (!Number.isFinite(px)) px = 0;
    if (!Number.isFinite(py)) py = 0;

    if (px >= BLOCK_SIZE || px < 0) {
      const carryX = Math.floor(px / BLOCK_SIZE);
      bx = bx + carryX;
      px = px - carryX * BLOCK_SIZE;
      if (px < 0) { px += BLOCK_SIZE; bx -= 1; }
    }
    if (py >= BLOCK_SIZE || py < 0) {
      const carryY = Math.floor(py / BLOCK_SIZE);
      by = by + carryY;
      py = py - carryY * BLOCK_SIZE;
      if (py < 0) { py += BLOCK_SIZE; by -= 1; }
    }
    return { blockX: bx, blockB: by, pxX: px, pxY: py };
  }
  function toGlobalUI(bx, by, lx, ly, BLOCK_SIZE) { return { gx: bx * BLOCK_SIZE + lx, gy: by * BLOCK_SIZE + ly }; }

  // pick coords from page (keeps original logic)
  async function pickCoordsFromPage() {
    try {
      const el = document.getElementById('bm-h') || document.querySelector('[id="bm-h"]');
      const raw = el ? (el.innerText || el.textContent || '') : '';
      const coords = typeof parseBmH === 'function' ? parseBmH(raw) : null;
      if (coords) return { ok: true, coords };
    } catch (e) {}
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
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  async function applyPickedCoords(kind) {
    try {
      const res = await pickCoordsFromPage();
      // INSERTED LOG: show raw pick result coming from page or runtime
      try { console.log('[PANEL] applyPickedCoords kind=' + kind + ' rawPickResult=', res); } catch (e) {}
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
      storageSet('pxf_settings', collectSettingsFromUI());
    } catch (e) { log('error','applyPickedCoords error', String(e)); }
  }

  // wire pick buttons
  if (pickStartBtn) pickStartBtn.addEventListener('click', async () => { pickStartBtn.disabled = true; try { await applyPickedCoords('start'); } finally { pickStartBtn.disabled = false; } });
  if (pickEndBtn) pickEndBtn.addEventListener('click', async () => { pickEndBtn.disabled = true; try { await applyPickedCoords('end'); } finally { pickEndBtn.disabled = false; } });

  // start/stop handlers (original logic) — modified to compute safer Total estimate
  if (startBtn) startBtn.addEventListener('click', async () => {
    startBtn.disabled = true; if (stopBtn) stopBtn.disabled = false;
    const cfg = collectSettingsFromUI();

    // INSERTED LOG: show cfg sent and delay seconds conversion
    try { console.log('[PANEL] start-fetch sending cfg:', cfg); } catch (e) {}
    try {
      const delayMin = Number(cfg.BATCH_DELAY_MINUTES != null ? cfg.BATCH_DELAY_MINUTES : 0.045);
      try { console.log('[PANEL] BATCH_DELAY_MINUTES', delayMin, '=> nextDelaySeconds', Math.round(delayMin * 60)); } catch (e) {}
    } catch (e) {}

    // safer Total estimate using normalization and UI_BLOCK_SIZE
    try {
      const s = normalizeBlockPixelUI(cfg.startBlockX, cfg.startBlockY, cfg.startX, cfg.startY, UI_BLOCK_SIZE);
      const e = normalizeBlockPixelUI(cfg.endBlockX, cfg.endBlockY, cfg.endX, cfg.endY, UI_BLOCK_SIZE);
      const g1tmp = toGlobalUI(s.blockX, s.blockB, s.pxX, s.pxY, UI_BLOCK_SIZE);
      const g2tmp = toGlobalUI(e.blockX, e.blockB, e.pxX, e.pxY, UI_BLOCK_SIZE);
      const minGXtmp = Math.min(g1tmp.gx, g2tmp.gx), maxGXtmp = Math.max(g1tmp.gx, g2tmp.gx);
      const minGYtmp = Math.min(g1tmp.gy, g2tmp.gy), maxGYtmp = Math.max(g1tmp.gy, g2tmp.gy);
      const totalX = Math.floor((maxGXtmp - minGXtmp) / (cfg.stepX || 1)) + 1;
      const totalY = Math.floor((maxGYtmp - minGYtmp) / (cfg.stepY || 1)) + 1;
      const totalEstimate = Math.max(0, totalX * totalY);

      // INSERTED LOG: show normalization and estimate details
      try { console.log('[PANEL] normalized start', s, 'normalized end', e, 'g1tmp', g1tmp, 'g2tmp', g2tmp, 'stepX', cfg.stepX, 'stepY', cfg.stepY, 'totalEstimate', totalEstimate); } catch (err) {}

      log('info','Starting job via background', { summary:`blocks ${cfg.startBlockX},${cfg.startBlockY} -> ${cfg.endBlockX},${cfg.endBlockY}, Total: ${totalEstimate}` });
    } catch (e) {
      log('info','Starting job via background', { summary:`blocks ${cfg.startBlockX},${cfg.startBlockY} -> ${cfg.endBlockX},${cfg.endBlockY}` });
    }

    try { chrome.storage.local.remove('__PIXEL_FETCHER_STOP__'); } catch (e){}
    chrome.runtime.sendMessage({ type: 'start-fetch', cfg }, resp => {
      if (resp && resp.ok) {
        storageSet('__PXF_RUNNING__', { running:true, startedAt: Date.now(), cfg });
        log('info','Background accepted start', { jobId: resp.jobId });
      } else if (resp && resp.error === 'already-running') {
        log('warn','Start rejected: already-running. Try stop then retry.');
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
        try { chrome.storage.local.remove('__PIXEL_JOB_STORE__'); } catch(e){}
      } else {
        log('warn','Background stop may have failed', resp);
        stopBtn.disabled = false;
      }
    });
  });

  if (clearBtn) clearBtn.addEventListener('click', () => { if (logEl) logEl.innerHTML = ''; });

  // load persisted settings
  (async function loadSettings(){
    try {
      const s = await storageGet('pxf_settings');
      const cfg = s || {};
      fields.forEach(f => { if (cfg[f] != null && inputs[f]) inputs[f].value = String(cfg[f]); });
    } catch (e) {}
  })();

  // poll progress and recent events
  let pollSeen = new Set();
  async function pollProgressAndEvents() {
    try {
      const pRaw = await storageGet('__PXF_PROGRESS__');
      const progress = pRaw || null;

      // INSERTED LOG: raw progress polled from storage
      try { if (progress) console.log('[PANEL] polled __PXF_PROGRESS__ raw:', progress); } catch (e) {}

      if (progress) {
        const key = JSON.stringify({ done: progress.done, total: progress.total, ts: progress.timestamp || '' }).slice(0,200);
        if (!pollSeen.has(key)) {
          pollSeen.add(key);
          if (progress.lastBatch) {
            const lb = progress.lastBatch;
            // include elapsedSeconds if available in lastBatch
            log('info', `Batch ${lb.batchStartIndex}→${lb.batchEndIndex} (${lb.batchCount})`, { durationMs: lb.batchDurationMs, elapsedSec: lb.batchElapsedSec || null });
          } else {
            log('info', `Progress ${progress.done}/${progress.total}`, progress);
          }
          if (progress.finished || progress.stopped) {
            try { chrome.storage.local.remove('__PXF_RUNNING__'); } catch(e){}
            if (startBtn) startBtn.disabled = false;
            if (stopBtn) stopBtn.disabled = true;
          }
        }
      }
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

  // storage changes listener
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

  // cleanup on unload
  window.addEventListener('beforeunload', () => {
    try { clearInterval(pollInterval); } catch(e){}
  });

})();
