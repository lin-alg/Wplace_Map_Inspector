'use strict';

(function(root){
  const api = {};

  function getSuggestedName() {
    try {
      return 'wplace_verbose_' + new Date().toISOString().replace(/[.:]/g, '-') + '.csv';
    } catch (e) {
      return 'wplace_verbose_export.csv';
    }
  }

  async function requestHandlePermission(handle) {
    if (!handle || typeof handle.requestPermission !== 'function') return true;
    try {
      const res = await handle.requestPermission({ mode: 'readwrite' }).catch(() => null);
      return res === 'granted';
    } catch (err) {
      console.warn('[WPI_STREAM] requestPermission error', err);
      return false;
    }
  }

  api.pickVerboseTarget = async function pickVerboseTarget(currentValue) {
    const suggestedName = getSuggestedName();
    const w = typeof window !== 'undefined' ? window : null;

    if (w && typeof w.showSaveFilePicker === 'function') {
      try {
        const handle = await w.showSaveFilePicker({
          suggestedName,
          types: [{ description: 'CSV 文件', accept: { 'text/csv': ['.csv'] } }]
        });
        if (handle) {
          const granted = await requestHandlePermission(handle);
          if (!granted) return { ok: false, error: 'permission-denied' };
          return { ok: true, label: handle.name || suggestedName, via: 'save-file-picker', handle, permissionGranted: true };
        }
      } catch (err) {
        if (err && err.name === 'AbortError') return { ok: false, cancelled: true };
        console.warn('[WPI_STREAM] showSaveFilePicker error', err);
        return { ok: false, error: String(err) };
      }
    }

    if (w && typeof w.showDirectoryPicker === 'function') {
      try {
        const dirHandle = await w.showDirectoryPicker();
        if (dirHandle) {
          const label = (dirHandle.name || '选定目录') + '/' + suggestedName;
          return { ok: true, label, via: 'directory-picker' };
        }
      } catch (err) {
        if (err && err.name === 'AbortError') return { ok: false, cancelled: true };
        console.warn('[WPI_STREAM] showDirectoryPicker error', err);
        return { ok: false, error: String(err) };
      }
    }

    if (w && typeof w.prompt === 'function') {
      const manual = w.prompt('请输入保存路径（仅作为占位描述）', currentValue || suggestedName);
      if (!manual) return { ok: false, cancelled: true };
      return { ok: true, label: manual.trim(), via: 'manual-input' };
    }

    return { ok: false, error: 'unsupported-environment' };
  };

  api.ensureOffscreenReady = async function ensureOffscreenReady() {
    if (!(root && root.chrome && root.chrome.runtime && root.chrome.runtime.sendMessage)) {
      return { ok: false, error: 'no-runtime' };
    }
    return new Promise(resolve => {
      try {
        root.chrome.runtime.sendMessage({ type: 'ensure-offscreen' }, resp => {
          const lastErr = root.chrome.runtime.lastError;
          if (lastErr) {
            resolve({ ok: false, error: lastErr.message || 'runtime-error' });
            return;
          }
          resolve(resp && typeof resp.ok !== 'undefined' ? resp : { ok: true });
        });
      } catch (err) {
        resolve({ ok: false, error: String(err) });
      }
    });
  };

  async function registerViaBroadcast(handle, meta) {
    if (typeof BroadcastChannel !== 'function') return null;
    const sessionId = `bc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const metaPayload = Object.assign({}, meta, { permissionGranted: !!(meta && meta.permissionGranted) });
    const channel = new BroadcastChannel('wpi-stream-channel');
    return new Promise(resolve => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { channel.close(); } catch (e) {}
        resolve({ ok: false, error: 'timeout' });
      }, 8000);
      channel.addEventListener('message', function listener(evt) {
        const data = evt.data || {};
        if (data.type !== 'store-handle-result' || data.sessionId !== sessionId) return;
        channel.removeEventListener('message', listener);
        clearTimeout(timer);
        settled = true;
        try { channel.close(); } catch (e) {}
        resolve({ ok: !!data.ok, error: data.error });
      });
      try {
        channel.postMessage({ type: 'store-handle', sessionId, meta: metaPayload, handle });
      } catch (err) {
        clearTimeout(timer);
        settled = true;
        try { channel.close(); } catch (e) {}
        resolve({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    });
  }

  function registerViaRuntime(handle, meta) {
    return new Promise(resolve => {
      try {
        root.chrome.runtime.sendMessage({
          __offscreen__: true,
          command: 'store-handle',
          payload: {
            handle,
            label: meta.label,
            via: meta.via,
            permissionGranted: !!meta.permissionGranted
          }
        }, resp => {
          const lastErr = root.chrome.runtime.lastError;
          if (lastErr) {
            resolve({ ok: false, error: lastErr.message || 'runtime-error' });
            return;
          }
          resolve(resp || { ok: false, error: 'no-response' });
        });
      } catch (err) {
        resolve({ ok: false, error: String(err) });
      }
    });
  }

  api.registerHandle = async function registerHandle(handle, meta = {}) {
    if (!handle) return { ok: false, error: 'no-handle' };
    const ensured = await api.ensureOffscreenReady();
    if (!ensured || ensured.ok === false) return ensured || { ok: false, error: 'ensure-offscreen-failed' };
    const bcResult = await registerViaBroadcast(handle, meta);
    if (bcResult && bcResult.ok !== undefined) {
      if (bcResult.ok) return bcResult;
      // fall through to runtime path only if broadcast unavailable (null) or timed out
      if (bcResult.error !== 'timeout') return bcResult;
    }
    return registerViaRuntime(handle, meta);
  };

  if (!root.WPIStreaming) {
    root.WPIStreaming = api;
  } else {
    Object.assign(root.WPIStreaming, api);
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
