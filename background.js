// background.js - concurrency-aware batch executor with fast authoritative stop (full file)
// Modified: add normalization of block+pixel to match UI and injected scripts
// Modified: track pixels count per paintedBy.id (job._seenIds entries include pixels)
// Modified: export snapshot on stop (both stop-fetch message and stopJob) before clearing job
'use strict';

const RUN_STATE_KEY = '__PXF_RUNNING__';
const PROGRESS_KEY = '__PXF_PROGRESS__';
const JOB_STORE_KEY = '__PXF_JOB_STORE__';
const STOP_FLAG_KEY = '__PIXEL_FETCHER_STOP__';
const BATCH_ALARM_NAME = 'pxf_batch_alarm';

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_BATCH_DELAY_MINUTES = 0.045; // ~2.7s
const DEFAULT_MAX_RPS = 6;
const DEFAULT_CONCURRENCY = 4;
const SAMPLE_LIMIT = 200;
const URL_REVOKE_DELAY_MS = 30000;
const VERBOSE_STREAM_BATCH_SIZE = 250;
const OFFSCREEN_DOCUMENT_URL = 'offscreen.html';
const VERBOSE_CSV_HEADER = ['blockX','blockB','x','y','paintedById','paintedByName','paintedByAlliance'].join(',') + '\n';
const STREAM_PICKER_SESSIONS = new Map();

function ensurePickerSession(sessionId) {
  if (!sessionId) return null;
  if (!STREAM_PICKER_SESSIONS.has(sessionId)) {
    STREAM_PICKER_SESSIONS.set(sessionId, {
      sessionId,
      sourceTabId: null,
      windowId: null,
      tabId: null,
      openedAt: Date.now(),
      streaming: false,
      hasHandle: false,
      label: null,
      via: null,
      activeJobId: null,
      lastPing: Date.now()
    });
  }
  const rec = STREAM_PICKER_SESSIONS.get(sessionId);
  rec.lastPing = Date.now();
  return rec;
}

function getReadyPickerSession() {
  for (const [sessionId, info] of STREAM_PICKER_SESSIONS.entries()) {
    if (info && info.streaming && !info.detached) {
      return { sessionId, info };
    }
  }
  return null;
}

function updatePickerSession(sessionId, patch) {
  const rec = ensurePickerSession(sessionId);
  if (!rec) return null;
  Object.assign(rec, patch || {});
  rec.lastPing = Date.now();
  STREAM_PICKER_SESSIONS.set(sessionId, rec);
  return rec;
}

async function closePickerWindow(sessionId) {
  const info = STREAM_PICKER_SESSIONS.get(sessionId);
  if (!info || !info.windowId) return;
  await new Promise(resolve => {
    try {
      chrome.windows.remove(info.windowId, () => {
        const lastErr = chrome.runtime.lastError;
        if (lastErr) {
          resolve(false);
          return;
        }
        resolve(true);
      });
    } catch (err) {
      resolve(false);
    }
  }).catch(() => {});
}

async function sendPickerWriterCommand(sessionId, action, payload = {}) {
  if (!sessionId) return { ok: false, error: 'missing-session' };
  return await new Promise(resolve => {
    try {
      const message = Object.assign({ __stream_cmd__: true, type: 'verbose-writer-command', sessionId, action }, payload);
      chrome.runtime.sendMessage(message, resp => {
        const lastErr = chrome.runtime.lastError;
        if (lastErr) {
          resolve({ ok: false, error: lastErr.message || 'runtime-error' });
          return;
        }
        resolve(resp || { ok: false, error: 'no-response' });
      });
    } catch (err) {
      resolve({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  });
}

function detachPickerSession(sessionId, reason) {
  const info = STREAM_PICKER_SESSIONS.get(sessionId);
  if (!info) return;
  info.streaming = false;
  info.hasHandle = false;
  info.activeJobId = null;
  info.detached = reason || true;
  STREAM_PICKER_SESSIONS.set(sessionId, info);
}

let GLOBAL_ABORT = false;
let GLOBAL_ABORT_CONTROLLER = null;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getStorage(keys) {
  return new Promise(resolve => {
    try { chrome.storage.local.get(keys, res => resolve(res || {})); }
    catch (e) { console.warn('[BG] getStorage error', e); resolve({}); }
  });
}
async function setStorageKey(key, value) {
  try { await chrome.storage.local.set({ [key]: value }); }
  catch (e) { console.warn('[BG] setStorageKey', key, e); }
}
async function removeStorage(key) {
  try { await chrome.storage.local.remove(key); }
  catch (e) { console.warn('[BG] removeStorage', key, e); }
}

async function writeProgress(payload) {
  const out = Object.assign({}, payload, { _meta: { writer: 'background', ts: Date.now() } });
  await setStorageKey(PROGRESS_KEY, out);
}
async function writeRunState(payload) {
  const out = Object.assign({}, payload, { _meta: { writer: 'background', ts: Date.now() } });
  await setStorageKey(RUN_STATE_KEY, out);
}
async function writeStopFlag() {
  await setStorageKey(STOP_FLAG_KEY, '1');
}

function TokenBucket(rate, capacity) {
  this.rate = rate;
  this.capacity = capacity;
  this._tokens = capacity;
  this._last = Date.now();
}
TokenBucket.prototype.consume = function(tokens = 1) {
  const now = Date.now();
  const elapsed = (now - this._last) / 1000;
  this._last = now;
  this._tokens = Math.min(this.capacity, this._tokens + elapsed * this.rate);
  if (tokens <= this._tokens) { this._tokens -= tokens; return 0; }
  const need = (tokens - this._tokens) / this.rate;
  this._tokens = 0;
  return need * 1000;
};

function buildUrlFromTpl(cfg, blockX, blockB, lx, ly) {
  const tpl = (cfg.BASE_TEMPLATE || '').trim();
  if (tpl) {
    if (tpl.includes('{blockX}') || tpl.includes('{blockB}') || tpl.includes('{lx}') || tpl.includes('{ly}')) {
      return tpl.replace(/\{blockX\}/g, blockX).replace(/\{blockB\}/g, blockB).replace(/\{lx\}/g, lx).replace(/\{ly\}/g, ly);
    }
    return tpl + (tpl.endsWith('/') ? '' : '/') + blockX + '/' + blockB + '?x=' + lx + '&y=' + ly;
  }
  return `https://backend.wplace.live/s0/pixel/${blockX}/${blockB}?x=${lx}&y=${ly}`;
}

// normalize a block+pixel pair so px in [0, BLOCK_SIZE-1] and carry to blocks when overflow/underflow
function normalizeBlockPixel(blockX, blockB, pxX, pxY, BLOCK_SIZE) {
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

function computeCoords(cfg) {
  // Use the same normalization semantics as UI and injected fetcher
  const BLOCK_SIZE = Number(cfg.BLOCK_SIZE || 1000);

  const sNorm = normalizeBlockPixel(cfg.startBlockX, cfg.startBlockY, cfg.startX, cfg.startY, BLOCK_SIZE);
  const eNorm = normalizeBlockPixel(cfg.endBlockX, cfg.endBlockY, cfg.endX, cfg.endY, BLOCK_SIZE);

  const g1x = (Number(sNorm.blockX) * BLOCK_SIZE) + Number(sNorm.pxX);
  const g1y = (Number(sNorm.blockB) * BLOCK_SIZE) + Number(sNorm.pxY);
  const g2x = (Number(eNorm.blockX) * BLOCK_SIZE) + Number(eNorm.pxX);
  const g2y = (Number(eNorm.blockB) * BLOCK_SIZE) + Number(eNorm.pxY);

  const minGX = Math.min(g1x, g2x), maxGX = Math.max(g1x, g2x);
  const minGY = Math.min(g1y, g2y), maxGY = Math.max(g1y, g2y);
  const stepX = Math.max(1, Number(cfg.stepX || 1));
  const stepY = Math.max(1, Number(cfg.stepY || 1));
  const coords = [];
  for (let gx = minGX; gx <= maxGX; gx += stepX) {
    for (let gy = minGY; gy <= maxGY; gy += stepY) {
      const blockX = Math.floor(gx / BLOCK_SIZE);
      const blockB = Math.floor(gy / BLOCK_SIZE);
      const lx = ((gx % BLOCK_SIZE) + BLOCK_SIZE) % BLOCK_SIZE;
      const ly = ((gy % BLOCK_SIZE) + BLOCK_SIZE) % BLOCK_SIZE;
      coords.push({ blockX, blockB, lx, ly });
    }
  }
  for (let i = coords.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [coords[i], coords[j]] = [coords[j], coords[i]];
  }
  return coords;
}

async function ensureOffscreenDocument() {
  try {
    if (!chrome.offscreen || typeof chrome.offscreen.createDocument !== 'function') return false;
    if (typeof chrome.offscreen.hasDocument === 'function') {
      const hasDoc = await chrome.offscreen.hasDocument();
      if (hasDoc) return true;
    }
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_URL,
      reasons: ['BLOBS'],
      justification: 'Stream verbose CSV rows to disk'
    });
    return true;
  } catch (e) {
    console.warn('[BG] ensureOffscreenDocument error', e);
    try {
      if (typeof chrome.offscreen?.hasDocument === 'function') {
        return await chrome.offscreen.hasDocument();
      }
    } catch (err) { /* ignore */ }
    return false;
  }
}

async function sendOffscreenRequest(command, payload) {
  if (!chrome.offscreen) return null;
  const ok = await ensureOffscreenDocument();
  if (!ok) return null;
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage({ __offscreen__: true, command, payload }, resp => {
        const lastErr = chrome.runtime.lastError;
        if (lastErr) {
          console.warn('[BG] offscreen message error', lastErr.message || lastErr);
          resolve(null);
        } else {
          resolve(resp);
        }
      });
    } catch (e) {
      console.warn('[BG] sendOffscreenRequest exception', e);
      resolve(null);
    }
  });
}

async function hasStoredVerboseHandle() {
  try {
    const resp = await sendOffscreenRequest('has-handle', {});
    return !!(resp && resp.ok && resp.hasHandle);
  } catch (e) {
    console.warn('[BG] hasStoredVerboseHandle error', e);
    return false;
  }
}

async function tryInitVerboseStream(job) {
  if (!job || !job.cfg || !job.cfg.VERBOSE_MODE) return false;
  job._verboseStreamState = job._verboseStreamState || 'pending';
  if (job._verboseStreamState === 'active' || job._verboseStreamState === 'finalized') return job._verboseStreamState === 'active';
  if (job._verboseStreamState === 'initializing') return false;
  if (job._verboseStreamState === 'active') return true;

  // Prefer active picker writer sessions if available
  const readyPicker = getReadyPickerSession();
  if (readyPicker) {
    job._verboseStreamState = 'initializing';
    job._verboseStreamVia = 'picker';
    job._writerSessionId = readyPicker.sessionId;
    try {
      const resp = await sendPickerWriterCommand(readyPicker.sessionId, 'init', { jobId: job.jobId, header: VERBOSE_CSV_HEADER });
      if (resp && resp.ok) {
        job._verboseStreamState = 'active';
        job._verboseStreamCursor = job._verboseStreamCursor || 0;
        readyPicker.info.activeJobId = job.jobId;
        STREAM_PICKER_SESSIONS.set(readyPicker.sessionId, readyPicker.info);
        return true;
      }
      job._verboseStreamState = 'error';
      job._verboseStreamError = (resp && resp.error) || 'picker-init-failed';
      job._writerSessionId = null;
      job._verboseStreamVia = null;
      return false;
    } catch (e) {
      job._verboseStreamState = 'error';
      job._verboseStreamError = String(e?.message || e);
      job._writerSessionId = null;
      job._verboseStreamVia = null;
      console.warn('[BG] tryInitVerboseStream picker error', e);
      return false;
    }
  }

  if (!chrome.offscreen) return false;
  const hasHandle = await hasStoredVerboseHandle();
  if (!hasHandle) return false;
  job._verboseStreamState = 'initializing';
  try {
    const resp = await sendOffscreenRequest('init-writer', { jobId: job.jobId, header: VERBOSE_CSV_HEADER });
    if (resp && resp.ok) {
      job._verboseStreamState = 'active';
      job._verboseStreamCursor = job._verboseStreamCursor || 0;
      job._verboseStreamVia = 'offscreen';
      job._writerSessionId = null;
      return true;
    }
    job._verboseStreamState = 'error';
    job._verboseStreamError = (resp && resp.error) || 'init-failed';
    job._verboseStreamVia = null;
    return false;
  } catch (e) {
    job._verboseStreamState = 'error';
    job._verboseStreamError = String(e?.message || e);
    job._verboseStreamVia = null;
    console.warn('[BG] tryInitVerboseStream error', e);
    return false;
  }
}

async function flushVerboseEntriesToStream(job, { force } = {}) {
  if (!job || job._verboseStreamState !== 'active') return false;
  if (!Array.isArray(job.verboseEntries) || !job.verboseEntries.length) return false;
  const cursor = Number(job._verboseStreamCursor || 0);
  const total = job.verboseEntries.length;
  const pending = total - cursor;
  const threshold = force ? 1 : VERBOSE_STREAM_BATCH_SIZE;
  if (pending <= 0 || (!force && pending < threshold)) return false;
  if (job._verboseStreamFlushing) {
    job._verboseStreamNeedsFlush = job._verboseStreamNeedsFlush || force;
    return false;
  }
  job._verboseStreamFlushing = true;
  try {
    const rows = job.verboseEntries.slice(cursor, total);
    let resp = null;
    if (job._verboseStreamVia === 'picker' && job._writerSessionId) {
      resp = await sendPickerWriterCommand(job._writerSessionId, 'append', { jobId: job.jobId, rows });
    } else {
      resp = await sendOffscreenRequest('append-rows', { jobId: job.jobId, rows });
    }
    if (resp && resp.ok) {
      job._verboseStreamCursor = total;
      job._verboseStreamWrites = (job._verboseStreamWrites || 0) + rows.length;
      await chrome.storage.local.set({ [JOB_STORE_KEY]: job });
      return true;
    }
    job._verboseStreamState = 'error';
    job._verboseStreamError = (resp && resp.error) || 'append-failed';
    if (job._verboseStreamVia === 'picker' && job._writerSessionId) {
      detachPickerSession(job._writerSessionId, 'append-failed');
      job._writerSessionId = null;
      job._verboseStreamVia = null;
    }
    return false;
  } catch (e) {
    job._verboseStreamState = 'error';
    job._verboseStreamError = String(e?.message || e);
    if (job._verboseStreamVia === 'picker' && job._writerSessionId) {
      detachPickerSession(job._writerSessionId, 'append-exception');
      job._writerSessionId = null;
      job._verboseStreamVia = null;
    }
    console.warn('[BG] flushVerboseEntriesToStream error', e);
    return false;
  } finally {
    job._verboseStreamFlushing = false;
    if (job._verboseStreamNeedsFlush) {
      job._verboseStreamNeedsFlush = false;
      await flushVerboseEntriesToStream(job, { force: true });
    }
  }
}

async function finalizeVerboseStream(job, reason) {
  if (!job || (job._verboseStreamState !== 'active' && job._verboseStreamState !== 'initializing')) return false;
  try {
    await flushVerboseEntriesToStream(job, { force: true });
  } catch (e) { /* ignore */ }
  try {
    let resp = null;
    if (job._verboseStreamVia === 'picker' && job._writerSessionId) {
      resp = await sendPickerWriterCommand(job._writerSessionId, 'finalize', { jobId: job.jobId, reason });
      const info = STREAM_PICKER_SESSIONS.get(job._writerSessionId);
      if (info) {
        info.activeJobId = null;
        STREAM_PICKER_SESSIONS.set(job._writerSessionId, info);
      }
    } else {
      resp = await sendOffscreenRequest('finalize-writer', { jobId: job.jobId, reason });
    }
    if (!resp || resp.ok) {
      job._verboseStreamState = 'finalized';
      job._verboseStreamVia = null;
      job._writerSessionId = null;
      await chrome.storage.local.set({ [JOB_STORE_KEY]: job });
      return true;
    }
    throw new Error(resp.error || 'finalize-failed');
  } catch (e) {
    console.warn('[BG] finalizeVerboseStream error', e);
    job._verboseStreamState = 'error';
    job._verboseStreamError = String(e?.message || e);
    if (job._writerSessionId) detachPickerSession(job._writerSessionId, 'finalize-error');
    return false;
  }
}

async function downloadTextFile(filename, text, mimeType = 'text/plain;charset=utf-8') {
  try {
    const blob = new Blob([text], { type: mimeType });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename }, id => {
      const lastErr = chrome.runtime.lastError && chrome.runtime.lastError.message;
      console.log('[BG] downloads.download callback', { id, lastError: lastErr });
      setTimeout(() => {
        try { URL.revokeObjectURL(url); } catch (e) { }
      }, URL_REVOKE_DELAY_MS);
    });
    return true;
  } catch (e) {
    try {
      const b64 = btoa(unescape(encodeURIComponent(text)));
      const baseMime = (mimeType || 'text/plain;charset=utf-8').split(';')[0] || 'text/plain';
      const dataUrl = `data:${baseMime};base64,` + b64;
      chrome.downloads.download({ url: dataUrl, filename }, id => {
        const lastErr = chrome.runtime.lastError && chrome.runtime.lastError.message;
        console.log('[BG] downloads.download fallback callback', { id, lastError: lastErr });
      });
      return true;
    } catch (e2) {
      console.error('[BG] download fallback failed', e2);
      return false;
    }
  }
}

function escapeCsvValue(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (!/[",\n]/.test(str)) return str;
  return '"' + str.replace(/"/g, '""') + '"';
}

function recordsToCsv(records) {
  const header = ['blockX','blockB','x','y','pixels','paintedById','paintedByName'];
  const lines = [header.join(',')];
  (records || []).forEach(rec => {
    const pb = rec && rec.paintedBy ? rec.paintedBy : {};
    const row = [
      rec && rec.blockX,
      rec && rec.blockB,
      rec && (rec.x != null ? rec.x : rec.lx),
      rec && (rec.y != null ? rec.y : rec.ly),
      rec && rec.pixels,
      pb && pb.id,
      pb && pb.name
    ].map(escapeCsvValue);
    lines.push(row.join(','));
  });
  return lines.join('\n');
}

function verboseEntriesToCsv(entries) {
  if (!entries || !entries.length) return '';
  const header = ['blockX','blockB','x','y','paintedById','paintedByName','paintedByAlliance'];
  const lines = [header.join(',')];
  entries.forEach(entry => {
    const pb = entry && entry.paintedBy ? entry.paintedBy : {};
    const row = [
      entry && entry.blockX,
      entry && entry.blockB,
      entry && entry.x,
      entry && entry.y,
      pb && pb.id,
      pb && pb.name,
      pb && (pb.alliance || pb.guild || pb.group || '')
    ].map(escapeCsvValue);
    lines.push(row.join(','));
  });
  return lines.join('\n');
}

function pushVerboseEntry(job, coord, paintedBy) {
  try {
    if (!job || !job.cfg || !job.cfg.VERBOSE_MODE) return null;
    job.verboseEntries = job.verboseEntries || [];
    const entry = {
      blockX: coord.blockX,
      blockB: coord.blockB,
      x: coord.lx,
      y: coord.ly,
      sampledAt: Date.now(),
      paintedBy: paintedBy ? Object.assign({}, paintedBy) : null
    };
    job.verboseEntries.push(entry);
    return entry;
  } catch (e) {
    console.warn('[BG] verbose entry push failed', e);
    return null;
  }
}

// export current job snapshot (job._seenIds or job.recordsSample) to file; used by stop flows
async function exportJobSnapshotIfAny(reasonLabel) {
  try {
    const store = await getStorage([JOB_STORE_KEY]);
    const job = store[JOB_STORE_KEY];
    if (!job) return null;

    const info = { aggregated: null, verbose: null };
    const records = job._seenIds ? Object.values(job._seenIds) : (job.recordsSample || []);
    const clipped = (records || []).slice(0, SAMPLE_LIMIT);
    if (clipped.length) {
      const csv = recordsToCsv(clipped);
      const fname = `auto_fetch_snapshot_${reasonLabel || 'stop'}_${Date.now()}.csv`;
      await downloadTextFile(fname, csv, 'text/csv;charset=utf-8');
      info.aggregated = { filename: fname, count: clipped.length };
      console.log('[BG] exported snapshot', fname, 'count=', clipped.length);
    }

    if (job._verboseStreamState === 'active') {
      try {
        await flushVerboseEntriesToStream(job, { force: true });
        await sendOffscreenRequest('finalize-writer', { jobId: job.jobId, reason: reasonLabel || 'snapshot' });
        job._verboseStreamState = 'finalized';
        info.verbose = {
          filename: job.cfg && job.cfg.VERBOSE_PATH ? job.cfg.VERBOSE_PATH : 'streamed-file',
          count: job._verboseStreamCursor || job.verboseEntries.length,
          streamed: true
        };
        await chrome.storage.local.set({ [JOB_STORE_KEY]: job });
        console.log('[BG] verbose snapshot flushed to stream handle', info.verbose);
      } catch (e) {
        console.warn('[BG] verbose stream finalize during snapshot failed', e);
      }
    } else if (job.cfg && job.cfg.VERBOSE_MODE && Array.isArray(job.verboseEntries) && job.verboseEntries.length) {
      const verboseCsv = verboseEntriesToCsv(job.verboseEntries);
      if (verboseCsv) {
        const verboseName = `auto_fetch_verbose_snapshot_${reasonLabel || 'stop'}_${Date.now()}.csv`;
        await downloadTextFile(verboseName, verboseCsv, 'text/csv;charset=utf-8');
        info.verbose = { filename: verboseName, count: job.verboseEntries.length };
        console.log('[BG] exported verbose snapshot', verboseName, 'count=', job.verboseEntries.length);
      }
    }

    if (info.aggregated || info.verbose) {
      await writeProgress({
        stopped: true,
        reason: reasonLabel || 'snapshot-export',
        filename: info.aggregated && info.aggregated.filename,
        count: info.aggregated && info.aggregated.count,
        verboseFilename: info.verbose && info.verbose.filename,
        verboseCount: info.verbose && info.verbose.count,
        verboseStreamState: job._verboseStreamState,
        ts: Date.now()
      });
    }

    return info.aggregated || info.verbose ? info : null;
  } catch (e) {
    console.warn('[BG] exportJobSnapshotIfAny failed', e);
    return null;
  }
}

async function startOrResumeJob(cfg) {
  cfg = cfg || {};

  // Normalize and ensure cfg is persisted with sensible defaults
  cfg.BATCH_SIZE = Math.max(1, Number(cfg.BATCH_SIZE || DEFAULT_BATCH_SIZE));
  cfg.BATCH_DELAY_MINUTES = Math.max(0, Number(cfg.BATCH_DELAY_MINUTES != null ? cfg.BATCH_DELAY_MINUTES : DEFAULT_BATCH_DELAY_MINUTES));
  cfg.MAX_RPS = Math.max(1, Number(cfg.MAX_RPS || DEFAULT_MAX_RPS));
  cfg.CONCURRENCY = Math.max(1, Number(cfg.CONCURRENCY || DEFAULT_CONCURRENCY));
  cfg.BLOCK_SIZE = Number(cfg.BLOCK_SIZE || 1000);

  const coords = computeCoords(cfg);
  const job = {
    jobId: Date.now(),
    cfg, // normalized cfg persisted
    coords,
    nextIndex: 0,
    recordsSample: [],
    stats: { ok: 0, fail: 0, _429: 0, _403: 0, err: 0 },
    _startTime: Date.now(),
    _lastBatchTs: null,
    _seenIds: {},
    verboseEntries: cfg.VERBOSE_MODE ? [] : null,
    _verboseStreamState: cfg.VERBOSE_MODE ? 'pending' : 'disabled',
    _verboseStreamCursor: 0,
    _writerSessionId: null,
    _verboseStreamVia: null
  };

  if (cfg.VERBOSE_MODE) {
    try { await tryInitVerboseStream(job); }
    catch (e) { console.warn('[BG] verbose stream init at start failed', e); }
  }

  await chrome.storage.local.set({ [JOB_STORE_KEY]: job });
  await writeRunState({ running: true, startedAt: Date.now(), jobId: job.jobId, total: coords.length, cfg });
  chrome.alarms.create(BATCH_ALARM_NAME, { delayInMinutes: cfg.BATCH_DELAY_MINUTES });
  console.log('[BG] scheduled job', job.jobId, 'total', coords.length, 'batchSize', cfg.BATCH_SIZE, 'delayMin', cfg.BATCH_DELAY_MINUTES, 'cfg:', cfg);
  return job.jobId;
}

async function stopJob() {
  try {
    GLOBAL_ABORT = true;
    if (GLOBAL_ABORT_CONTROLLER) {
      try { GLOBAL_ABORT_CONTROLLER.abort(); } catch (e) {}
    }

    // export snapshot if any before clearing job
    try {
      const snap = await exportJobSnapshotIfAny('requested-by-bg');
      if (snap) console.log('[BG] stopJob exported snapshot', snap);
    } catch (e) { console.warn('[BG] stopJob snapshot export error', e); }

    await writeProgress({ stopped: true, reason: 'requested-by-bg', ts: Date.now() });
    await writeStopFlag();
    chrome.alarms.clear(BATCH_ALARM_NAME);
    await removeStorage(JOB_STORE_KEY);
    await removeStorage(RUN_STATE_KEY);
    console.log('[BG] stopped job and cleared state (authoritative)');
  } catch (e) { console.error('[BG] stopJob error', e); }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm || alarm.name !== BATCH_ALARM_NAME) return;
  try {
    const store = await getStorage([JOB_STORE_KEY]);
    const job = store[JOB_STORE_KEY];
    if (!job || !Array.isArray(job.coords)) {
      console.log('[BG] alarm fired but no job found');
      return;
    }
    if (job.cfg && job.cfg.VERBOSE_MODE && job._verboseStreamState !== 'active') {
      try {
        const activated = await tryInitVerboseStream(job);
        if (activated) {
          await chrome.storage.local.set({ [JOB_STORE_KEY]: job });
        }
      } catch (e) {
        console.warn('[BG] alarm verbose stream init error', e);
      }
    }
    if (job.cfg && job.cfg.VERBOSE_MODE && !Array.isArray(job.verboseEntries)) {
      job.verboseEntries = [];
    }

    // reset abort signal for this batch
    GLOBAL_ABORT = false;
    GLOBAL_ABORT_CONTROLLER = new AbortController();
    const signal = GLOBAL_ABORT_CONTROLLER.signal;

    const cfg = job.cfg || {};
    const coords = job.coords;
    const start = job.nextIndex || 0;
    if (start >= coords.length) {
      console.log('[BG] job appears complete, clearing job store', job.jobId);
      await removeStorage(JOB_STORE_KEY);
      await removeStorage(RUN_STATE_KEY);
      return;
    }

    const batchSize = Number(cfg.BATCH_SIZE || DEFAULT_BATCH_SIZE);
    const end = Math.min(coords.length, start + batchSize);

    const maxRps = Math.max(1, Number(cfg.MAX_RPS || DEFAULT_MAX_RPS));
    const bucket = new TokenBucket(maxRps, Math.max(1, maxRps));
    const concurrency = Math.max(1, Number(cfg.CONCURRENCY || DEFAULT_CONCURRENCY));

    console.log('[BG] alarm handler starting batch', { jobId: job.jobId, start, end, batchSize, maxRps, concurrency, cfgDelayMin: cfg.BATCH_DELAY_MINUTES });

    const batchStartTs = Date.now();
    job._seenIds = job._seenIds || {};

    async function fetchCoord(coord) {
      if (GLOBAL_ABORT) return { ok: false, reason: 'aborted' };
      const waitMs = bucket.consume(1);
      if (waitMs > 0) await sleep(waitMs + Math.floor(Math.random() * 50));
      if (GLOBAL_ABORT) return { ok: false, reason: 'aborted' };
      try {
        const url = buildUrlFromTpl(cfg, coord.blockX, coord.blockB, coord.lx, coord.ly);
        const resp = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal });
        if (resp && resp.ok) {
          const data = await resp.json().catch(() => null);
          if (data) {
            const pb = data.paintedBy || null;
            const pbId = pb && pb.id != null ? String(pb.id) : null;
            const pbClone = (pb && typeof pb === 'object') ? Object.assign({}, pb) : pb;
            if (pbClone && ('picture' in pbClone)) delete pbClone.picture;

            // Track pixels per id (and a special __noid bucket)
            if (pbId !== null) {
              if (!job._seenIds[pbId]) {
                job._seenIds[pbId] = {
                  blockX: coord.blockX,
                  blockB: coord.blockB,
                  x: coord.lx,
                  y: coord.ly,
                  paintedBy: pbClone,
                  pixels: 1
                };
              } else {
                job._seenIds[pbId].pixels = (job._seenIds[pbId].pixels || 0) + 1;
              }
            } else {
              const nk = '__noid';
              if (!job._seenIds[nk]) {
                job._seenIds[nk] = {
                  blockX: coord.blockX,
                  blockB: coord.blockB,
                  x: coord.lx,
                  y: coord.ly,
                  paintedBy: pbClone,
                  pixels: 1
                };
              } else {
                job._seenIds[nk].pixels = (job._seenIds[nk].pixels || 0) + 1;
              }
            }

            const vEntry = pushVerboseEntry(job, coord, pbClone);
            if (vEntry && job._verboseStreamState === 'active') {
              try { await flushVerboseEntriesToStream(job); }
              catch (e) { console.warn('[BG] flush verbose stream inside fetchCoord failed', e); }
            }
          }
          job.stats.ok++;
          return { ok: true, status: 200 };
        } else {
          job.stats.fail++;
          if (resp && resp.status === 429) job.stats._429++;
          if (resp && resp.status === 403) job.stats._403++;
          console.warn('[BG] request non-ok', { status: resp && resp.status, url });
          return { ok: false, status: resp && resp.status };
        }
      } catch (e) {
        if (e && e.name === 'AbortError') {
          job.stats.err++;
          return { ok: false, reason: 'aborted' };
        }
        job.stats.err++;
        console.warn('[BG] fetch error', e && e.message);
        return { ok: false, err: String(e) };
      }
    }

    // batch concurrency pool
    const batchCoords = coords.slice(start, end);
    let processed = 0;

    const workers = new Array(concurrency).fill(null).map(async () => {
      while (true) {
        // quick authoritative stop check via storage to catch external stop writes
        try {
          const stObj = await getStorage([STOP_FLAG_KEY]);
          const st = stObj[STOP_FLAG_KEY];
          if (st === '1' || st === 1 || st === true || st === 'true') {
            GLOBAL_ABORT = true;
          }
        } catch (e) { /* ignore */ }

        if (GLOBAL_ABORT) {
          console.log('[BG] GLOBAL_ABORT observed inside worker, breaking');
          break;
        }

        const idx = processed;
        if (idx >= batchCoords.length) break;
        processed++;
        const coord = batchCoords[idx];
        await fetchCoord(coord);

        // persist progress occasionally
        if (((start + processed) % 5) === 0 || (start + processed) === end) {
          try {
            if (job._verboseStreamState === 'active') {
              await flushVerboseEntriesToStream(job);
            }
            job.nextIndex = start + processed;
            await chrome.storage.local.set({ [JOB_STORE_KEY]: job });
            const recordsArr = job._seenIds ? Object.values(job._seenIds).slice(0, SAMPLE_LIMIT) : job.recordsSample;
            await writeProgress({
              done: job.nextIndex,
              total: coords.length,
              records: recordsArr,
              stats: job.stats,
              timestamp: Date.now(),
              verboseCount: job.verboseEntries ? job.verboseEntries.length : 0,
              verboseEnabled: !!(cfg && cfg.VERBOSE_MODE),
              verboseStreamState: job._verboseStreamState
            });
          } catch (e) { /* best-effort */ }
        }
      }
    });

    // wait for workers, but allow abort to short-circuit via GLOBAL_ABORT_CONTROLLER
    try {
      await Promise.all(workers);
    } catch (e) {
      console.warn('[BG] workers aborted with error', e);
    }

    const batchEndTs = Date.now();
    const batchDurationMs = batchEndTs - batchStartTs;
    const cumulativeElapsedSec = job._startTime ? Math.round((batchEndTs - job._startTime) / 1000) : null;

    // advance nextIndex by number processed
    job.nextIndex = Math.min(coords.length, start + processed);
    job._lastBatchTs = batchEndTs;
    await chrome.storage.local.set({ [JOB_STORE_KEY]: job });

    const lastBatch = {
      batchStartIndex: start,
      batchEndIndex: job.nextIndex,
      batchCount: job.nextIndex - start,
      batchTimestamp: batchEndTs,
      batchDurationMs,
      batchElapsedSec: cumulativeElapsedSec
    };

    // build progress payload using job._seenIds as records
    const progressRecords = job._seenIds ? Object.values(job._seenIds).slice(0, SAMPLE_LIMIT) : job.recordsSample;
    const progressPayload = {
      done: job.nextIndex,
      total: coords.length,
      records: progressRecords,
      stats: job.stats,
      lastBatch,
      timestamp: Date.now(),
      finished: false,
      verboseCount: job.verboseEntries ? job.verboseEntries.length : 0,
      verboseEnabled: !!(cfg && cfg.VERBOSE_MODE),
      verboseStreamState: job._verboseStreamState
    };
    await writeProgress(progressPayload);

    // Compute elapsed including next batch delay for logging clarity
    const nextDelayMinutes = Number(cfg.BATCH_DELAY_MINUTES != null ? cfg.BATCH_DELAY_MINUTES : DEFAULT_BATCH_DELAY_MINUTES);
    const nextDelaySeconds = Math.round(nextDelayMinutes * 60);
    const elapsedSinceStartSec = job._startTime ? Math.round((batchEndTs - job._startTime) / 1000) : null;

    console.log('[BG] processed batch', start, '->', job.nextIndex, 'of', coords.length, 'durationMs=', batchDurationMs, 'elapsedSec=', elapsedSinceStartSec, 'nextDelaySec=', nextDelaySeconds, 'stats=', job.stats);

    const totalRequests = Math.max(1, job.stats.ok + job.stats.fail + job.stats.err);
    const rate429_403 = (job.stats._429 + job.stats._403) / totalRequests;
    if (rate429_403 > 0.05) {
      console.warn('[BG] high 429/403 ratio detected', { rate: rate429_403, jobId: job.jobId, stats: job.stats });
    }

    if (job.nextIndex < coords.length && !GLOBAL_ABORT) {
      const delayMinutes = Number(cfg.BATCH_DELAY_MINUTES || DEFAULT_BATCH_DELAY_MINUTES);
      console.log('[BG] scheduling next alarm', { jobId: job.jobId, nextIndex: job.nextIndex, delayMinutes });
      chrome.alarms.create(BATCH_ALARM_NAME, { delayInMinutes: delayMinutes });
    } else {
      if (GLOBAL_ABORT) {
        console.log('[BG] batch ended due to abort; leaving job cleared by stop flow or manual override');
      } else {
        // finished
        const final = {
          done: coords.length,
          total: coords.length,
          records: job._seenIds ? Object.values(job._seenIds) : job.recordsSample,
          stats: job.stats,
          finished: true,
          timestamp: Date.now(),
          verboseCount: job.verboseEntries ? job.verboseEntries.length : 0,
          verboseEnabled: !!(cfg && cfg.VERBOSE_MODE),
          verboseStreamState: job._verboseStreamState
        };
        await writeProgress(final);

        try {
          const aggregatedRecords = job._seenIds ? Object.values(job._seenIds) : job.recordsSample;
          const clipped = (aggregatedRecords || []).slice(0, SAMPLE_LIMIT);
          const csv = recordsToCsv(clipped);
          const fname = `auto_fetch_${Date.now()}.csv`;
          await downloadTextFile(fname, csv, 'text/csv;charset=utf-8');

          let verboseMeta = null;
          if (job._verboseStreamState === 'active') {
            try {
              await finalizeVerboseStream(job, 'completed');
              verboseMeta = {
                filename: cfg && cfg.VERBOSE_PATH ? cfg.VERBOSE_PATH : 'streamed-file',
                count: job._verboseStreamCursor || 0,
                streamed: true
              };
              console.log('[BG] verbose CSV streamed to handle', verboseMeta);
            } catch (e) {
              console.warn('[BG] finalize verbose stream on completion failed', e);
            }
          } else if (cfg && cfg.VERBOSE_MODE && Array.isArray(job.verboseEntries) && job.verboseEntries.length) {
            const verboseCsv = verboseEntriesToCsv(job.verboseEntries);
            if (verboseCsv) {
              const verboseName = `auto_fetch_verbose_${Date.now()}.csv`;
              await downloadTextFile(verboseName, verboseCsv, 'text/csv;charset=utf-8');
              verboseMeta = { filename: verboseName, count: job.verboseEntries.length };
              console.log('[BG] verbose CSV download requested', verboseName, 'count=', job.verboseEntries.length);
            }
          }

          await writeProgress({
            finished: true,
            filename: fname,
            count: clipped.length,
            verboseFilename: verboseMeta && verboseMeta.filename,
            verboseCount: verboseMeta ? verboseMeta.count : (job.verboseEntries ? job.verboseEntries.length : 0),
            verboseStreamed: verboseMeta ? !!verboseMeta.streamed : false,
            stats: job.stats
          });
          console.log('[BG] job finished, download requested', fname);
        } catch (e) {
          console.error('[BG] finish download error', e);
        }

        await removeStorage(JOB_STORE_KEY);
        await removeStorage(RUN_STATE_KEY);
        console.log('[BG] job fully completed and cleaned up', { jobId: job.jobId });
      }
    }
  } catch (err) {
    console.error('[BG] alarm handler error', err);
    chrome.alarms.create(BATCH_ALARM_NAME, { delayInMinutes: 0.2 });
  } finally {
    // cleanup abort controller for this batch
    if (GLOBAL_ABORT_CONTROLLER) {
      try { GLOBAL_ABORT_CONTROLLER = null; } catch (e) {}
    }
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.__offscreen__) {
    return false;
  }
  if (msg && msg.__stream_cmd__) {
    return false;
  }
  (async () => {
    if (msg.type === 'open-stream-picker') {
      try {
        const sessionId = msg.sessionId;
        if (!sessionId) {
          sendResponse({ ok: false, error: 'missing-session' });
          return;
        }
        const sourceTabId = sender && sender.tab && sender.tab.id;
        const pickerUrl = chrome.runtime.getURL(`stream-picker.html?session=${encodeURIComponent(sessionId)}`);
        const popup = await new Promise((resolve, reject) => {
          try {
            chrome.windows.create({
              url: pickerUrl,
              type: 'popup',
              width: 420,
              height: 420,
              focused: true
            }, win => {
              const lastErr = chrome.runtime.lastError;
              if (lastErr) { reject(lastErr); return; }
              resolve(win);
            });
          } catch (err) {
            reject(err);
          }
        });
        const tabId = popup && popup.tabs && popup.tabs[0] ? popup.tabs[0].id : undefined;
        updatePickerSession(sessionId, {
          sourceTabId,
          windowId: popup && popup.id,
          tabId,
          openedAt: Date.now(),
          streaming: false,
          detached: false
        });
        sendResponse({ ok: true });
      } catch (err) {
        console.error('[BG] open-stream-picker error', err);
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
      return;
    }

    if (msg.type === 'stream-picker-ready') {
      const sessionId = msg.sessionId;
      if (!sessionId) {
        sendResponse({ ok: false, error: 'missing-session' });
        return;
      }
      const patch = {
        hasHandle: !!msg.hasHandle,
        writerActive: !!msg.writerActive,
        detached: false
      };
      if (sender && sender.tab) {
        patch.tabId = sender.tab.id;
        patch.windowId = sender.tab.windowId;
      }
      if (msg.hasHandle) patch.streaming = true;
      updatePickerSession(sessionId, patch);
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'stream-picker-result') {
      const sessionId = msg.sessionId;
      if (!sessionId || !STREAM_PICKER_SESSIONS.has(sessionId)) {
        sendResponse({ ok: false, error: 'unknown-session' });
        return;
      }
      const info = STREAM_PICKER_SESSIONS.get(sessionId);
      if (msg.status === 'success' && msg.streaming) {
        updatePickerSession(sessionId, {
          streaming: true,
          hasHandle: true,
          label: msg.label,
          via: msg.via,
          detached: false
        });
      } else {
        await closePickerWindow(sessionId).catch(() => {});
        STREAM_PICKER_SESSIONS.delete(sessionId);
      }
      if (info && info.sourceTabId) {
        chrome.tabs.sendMessage(info.sourceTabId, Object.assign({ type: 'stream-picker-result' }, msg), () => {
          const lastErr = chrome.runtime.lastError;
          if (lastErr) {
            console.warn('[BG] send picker result to tab failed', lastErr.message || lastErr);
          }
        });
      }
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'stream-writer-aborted') {
      if (msg.sessionId && STREAM_PICKER_SESSIONS.has(msg.sessionId)) {
        const info = STREAM_PICKER_SESSIONS.get(msg.sessionId);
        info.streaming = false;
        info.hasHandle = false;
        info.activeJobId = null;
        info.detached = msg.reason || 'aborted';
        STREAM_PICKER_SESSIONS.set(msg.sessionId, info);
      }
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'stream-writer-window-closed') {
      if (msg.sessionId) {
        detachPickerSession(msg.sessionId, 'window-closed');
        STREAM_PICKER_SESSIONS.delete(msg.sessionId);
      }
      sendResponse({ ok: true });
      return;
    }

    try {
      if (!msg || !msg.type) { sendResponse({ ok: false, error: 'bad-msg' }); return; }

      if (msg.type === 'start-fetch') {
        const cfg = msg.cfg || {};
        console.log('[BG] start-fetch received cfg:', cfg);
        try {
          const existing = (await getStorage([JOB_STORE_KEY]))[JOB_STORE_KEY];
          if (existing) {
            const ageMs = existing._startTime ? (Date.now() - existing._startTime) : Infinity;
            const isFinished = existing.nextIndex != null && existing.coords && existing.nextIndex >= existing.coords.length;
            const STALE_THRESHOLD_MS = (cfg && cfg.STALE_THRESHOLD_MS) ? Number(cfg.STALE_THRESHOLD_MS) : (10 * 60 * 1000);
            if (isFinished || ageMs > STALE_THRESHOLD_MS) {
              console.log('[BG] found stale job; cleaning and starting new job', { jobId: existing.jobId, ageMs, isFinished });
              await writeProgress({ stopped: true, reason: 'stale-cleanup', staleAgeMs: ageMs, ts: Date.now() });
              await writeStopFlag();
              chrome.alarms.clear(BATCH_ALARM_NAME);
              await removeStorage(JOB_STORE_KEY);
              await removeStorage(RUN_STATE_KEY);
            } else {
              console.log('[BG] start-fetch rejected: already-running', { jobId: existing.jobId });
              sendResponse({ ok: false, error: 'already-running' });
              return;
            }
          }
          const jobId = await startOrResumeJob(cfg);
          console.log('[BG] start-fetch accepted jobId:', jobId);
          sendResponse({ ok: true, jobId });
        } catch (e) {
          console.error('[BG] start-fetch error', e);
          sendResponse({ ok: false, error: String(e) });
        }
        return;
      }

      if (msg.type === 'stop-fetch') {
        console.log('[BG] stop-fetch received from', sender && sender.id);
        try {
          GLOBAL_ABORT = true;
          if (GLOBAL_ABORT_CONTROLLER) {
            try { GLOBAL_ABORT_CONTROLLER.abort(); } catch (e) {}
          }

          // export snapshot if any before clearing job
          try {
            const snap = await exportJobSnapshotIfAny('requested-by-popup');
            if (snap) console.log('[BG] stop-fetch exported snapshot', snap);
          } catch (e) { console.warn('[BG] stop-fetch snapshot export error', e); }

          await writeProgress({ stopped: true, reason: 'requested-by-popup', ts: Date.now() });
          await writeStopFlag();
          chrome.alarms.clear(BATCH_ALARM_NAME);
          await removeStorage(JOB_STORE_KEY);
          await removeStorage(RUN_STATE_KEY);
          console.log('[BG] stop-fetch handled: stop flag set, alarms cleared, job cleared');
          sendResponse({ ok: true });
        } catch (e) {
          console.error('[BG] stop-fetch error', e);
          sendResponse({ ok: false, error: String(e) });
        }
        return;
      }

      if (msg.type === 'download-file' && msg.filename && typeof msg.text === 'string') {
        console.log('[BG] download-file request', msg.filename);
        const ok = await downloadTextFile(msg.filename, msg.text);
        sendResponse({ ok });
        return;
      }

      if (msg.type === 'ensure-offscreen') {
        try {
          const ok = await ensureOffscreenDocument();
          sendResponse({ ok: !!ok });
        } catch (e) {
          console.error('[BG] ensure-offscreen error', e);
          sendResponse({ ok: false, error: String(e) });
        }
        return;
      }

      if (msg.type === 'bg-log-event' && msg.payload) {
        try { console.log('[BG] log event ▶', msg.payload); } catch (e) {}
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: 'unknown-type' });
    } catch (e) {
      console.error('[BG] onMessage error', e);
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true;
});

// listen to storage changes to pick up stop flag set from popup/content quickly
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    if (changes && changes[STOP_FLAG_KEY]) {
      const v = changes[STOP_FLAG_KEY].newValue;
      if (v === '1' || v === 1 || v === true || v === 'true') {
        GLOBAL_ABORT = true;
        if (GLOBAL_ABORT_CONTROLLER) {
          try { GLOBAL_ABORT_CONTROLLER.abort(); } catch (e) {}
        }
        console.log('[BG] GLOBAL_ABORT set via storage change');
      }
    }
  }
});

console.log('[BG] service worker starting', new Date().toISOString());

chrome.windows.onRemoved.addListener(windowId => {
  for (const [sessionId, info] of STREAM_PICKER_SESSIONS.entries()) {
    if (info && info.windowId === windowId) {
      detachPickerSession(sessionId, 'window-closed');
      STREAM_PICKER_SESSIONS.delete(sessionId);
      if (info.sourceTabId) {
        chrome.tabs.sendMessage(info.sourceTabId, {
          type: 'stream-picker-result',
          sessionId,
          status: 'cancelled',
          interrupted: !!info.streaming,
          reason: 'picker-window-closed'
        }, () => {
          const lastErr = chrome.runtime.lastError;
          if (lastErr) {
            console.warn('[BG] notify picker cancellation error', lastErr.message || lastErr);
          }
        });
      }
    }
  }
});