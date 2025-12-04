'use strict';

const state = {
  savedHandle: null,
  savedInfo: null,
  writers: new Map()
};

const STREAM_CHANNEL_NAME = 'wpi-stream-channel';
const streamChannel = (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel(STREAM_CHANNEL_NAME) : null;

function escapeCsvValue(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (!/[",\n]/.test(str)) return str;
  return '"' + str.replace(/"/g, '""') + '"';
}

function formatVerboseRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return '';
  const lines = rows.map(row => {
    const pb = row && row.paintedBy ? row.paintedBy : {};
    const fields = [
      row && row.blockX,
      row && row.blockB,
      row && row.x,
      row && row.y,
      pb && pb.id,
      pb && pb.name,
      pb && (pb.alliance || pb.guild || pb.group || '')
    ];
    return fields.map(escapeCsvValue).join(',');
  });
  return lines.join('\n') + '\n';
}

async function ensureHandlePermission(handle) {
  const result = { ok: false, state: 'unknown' };
  if (!handle) {
    result.state = 'missing-handle';
    return result;
  }
  try {
    if (state.savedInfo && state.savedInfo.permissionGranted) {
      result.ok = true;
      result.state = 'granted-meta';
      return result;
    }
    if (handle.queryPermission) {
      const existing = await handle.queryPermission({ mode: 'readwrite' }).catch(() => null);
      result.state = existing || 'unknown';
      if (existing === 'granted') {
        result.ok = true;
      } else {
        result.ok = false;
      }
      return result;
    }
    result.ok = true;
    result.state = 'no-query';
    return result;
  } catch (err) {
    console.warn('[OFFSCREEN] ensureHandlePermission error', err);
    result.state = 'error';
    result.error = err && err.message ? err.message : String(err);
    return result;
  }
}

async function initWriter(jobId, headerLine) {
  try {
    if (!state.savedHandle) throw new Error('no-handle');
    const permState = await ensureHandlePermission(state.savedHandle);
    if (!permState.ok) {
      throw new Error('permission-denied');
    }
    if (state.writers.has(jobId)) {
      try { await finalizeWriter(jobId); } catch (e) { console.warn('[OFFSCREEN] finalize existing writer error', e); }
    }
    const stream = await state.savedHandle.createWritable({ keepExistingData: false });
    const encoder = new TextEncoder();
    if (headerLine) {
      await stream.write(encoder.encode(headerLine.endsWith('\n') ? headerLine : headerLine + '\n'));
    }
    state.writers.set(jobId, { stream, encoder });
    return true;
  } catch (err) {
    throw err;
  }
}

async function appendRows(jobId, rows) {
  try {
    if (!state.writers.has(jobId)) throw new Error('writer-missing');
    const chunk = formatVerboseRows(rows || []);
    if (!chunk) return 0;
    const { stream, encoder } = state.writers.get(jobId);
    await stream.write(encoder.encode(chunk));
    return rows.length;
  } catch (err) {
    throw err;
  }
}

async function finalizeWriter(jobId) {
  const writer = state.writers.get(jobId);
  if (!writer) return false;
  try {
    await writer.stream.close();
  } finally {
    state.writers.delete(jobId);
  }
  return true;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.__offscreen__) return;
  (async () => {
    try {
      const payload = msg.payload || {};
      switch (msg.command) {
        case 'store-handle': {
          const handle = payload.handle;
          const looksValid = !!handle && (handle.kind === 'file' || typeof handle.createWritable === 'function');
          if (looksValid) {
            state.savedHandle = payload.handle;
            state.savedInfo = {
              label: payload.label,
              via: payload.via,
              permissionGranted: !!payload.permissionGranted
            };
            sendResponse({ ok: true });
          } else {
            try {
              console.warn('[OFFSCREEN] invalid handle payload', {
                hasHandle: !!payload.handle,
                kind: payload.handle && payload.handle.kind,
                hasCreateWritable: !!(payload.handle && payload.handle.createWritable),
                keys: payload.handle ? Object.keys(payload.handle || {}) : null,
                ctor: payload.handle ? payload.handle.constructor && payload.handle.constructor.name : null
              });
            } catch (err) {
              console.warn('[OFFSCREEN] invalid handle logging error', err);
            }
            state.savedHandle = null;
            state.savedInfo = null;
            sendResponse({ ok: false, error: 'invalid-handle' });
          }
          break;
        }
        case 'has-handle': {
          sendResponse({ ok: true, hasHandle: !!state.savedHandle });
          break;
        }
        case 'init-writer': {
          await initWriter(payload.jobId, payload.header);
          sendResponse({ ok: true });
          break;
        }
        case 'append-rows': {
          const wrote = await appendRows(payload.jobId, payload.rows);
          sendResponse({ ok: true, wrote });
          break;
        }
        case 'finalize-writer': {
          await finalizeWriter(payload.jobId);
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'unknown-command' });
      }
    } catch (err) {
      console.error('[OFFSCREEN] command error', err);
      sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  })();
  return true;
});

if (streamChannel) {
  streamChannel.addEventListener('message', async (event) => {
    const data = event.data || {};
    if (!data || data.type !== 'store-handle' || !data.sessionId) return;
    const sessionId = data.sessionId;
    try {
      const handle = data.handle;
      const looksValid = !!handle && (handle.kind === 'file' || typeof handle.createWritable === 'function');
      if (!looksValid) throw new Error('invalid-handle');
      const permitted = await ensureHandlePermission(handle);
      if (!permitted.ok) throw new Error('permission-denied');
      state.savedHandle = handle;
      state.savedInfo = {
        label: data.meta && data.meta.label,
        via: data.meta && data.meta.via,
        permissionGranted: !!(data.meta && data.meta.permissionGranted)
      };
      streamChannel.postMessage({ type: 'store-handle-result', sessionId, ok: true });
    } catch (err) {
      streamChannel.postMessage({ type: 'store-handle-result', sessionId, ok: false, error: err && err.message ? err.message : String(err) });
    }
  });
}
