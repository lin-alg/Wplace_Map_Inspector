'use strict';

(function(){
  const params = new URLSearchParams(window.location.search || '');
  const sessionId = params.get('session') || null;

  const statusEl = document.getElementById('status');
  const pickBtn = document.getElementById('pickBtn');
  const cancelBtn = document.getElementById('cancelBtn');
  const writerSection = document.getElementById('writerSection');
  const fileLabelEl = document.getElementById('writerFileLabel');
  const writerJobEl = document.getElementById('writerJobId');
  const writerPixelCountEl = document.getElementById('writerPixelCount');
  const writerLastUpdateEl = document.getElementById('writerLastUpdate');
  const writerStateEl = document.getElementById('writerStateText');
  const stopWriterBtn = document.getElementById('stopWriterBtn');
  const startJobBtn = document.getElementById('startJobBtn');
  const writerElapsedEl = document.getElementById('writerElapsed');
  const writerEtaEl = document.getElementById('writerEta');
  const writerFileSizeEl = document.getElementById('writerFileSize');
  const writerUniqueCountEl = document.getElementById('writerUniqueCount');
  const STORAGE_KEYS = {
    RUN_STATE: '__PXF_RUNNING__',
    JOB_STORE: '__PXF_JOB_STORE__',
    PROGRESS: '__PXF_PROGRESS__',
    SETTINGS: 'pxf_settings'
  };

  const writerState = {
    handle: null,
    label: '',
    via: '',
    writable: null,
    encoder: new TextEncoder(),
    jobId: null,
    rowsWritten: 0,
    lastWriteTs: null,
    active: false,
    fileSizeBytes: 0
  };

  const monitorState = {
    elapsedMs: 0,
    etaMs: null,
    uniqueCount: 0,
    fileSizeBytes: 0,
    jobRunning: false,
    totalCoords: 0,
    doneCoords: 0,
    batchDurations: [],
    batchSizes: []
  };

  function storageGet(keys) {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get(keys, res => {
          const lastErr = chrome.runtime.lastError;
          if (lastErr) {
            console.warn('[WPI Picker] storage.get error', lastErr.message || lastErr);
            resolve({});
            return;
          }
          resolve(res || {});
        });
      } catch (err) {
        console.warn('[WPI Picker] storage.get exception', err);
        resolve({});
      }
    });
  }

  function unwrapStored(obj, key) {
    if (!obj) return null;
    if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
    return obj;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function setStatus(text, type) {
    if (!statusEl) return;
    statusEl.textContent = text || '';
    statusEl.className = type ? type : '';
  }

  function formatTs(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return d.toLocaleTimeString('zh-CN', { hour12: false });
  }

  function formatCountValue(num) {
    if (typeof num !== 'number' || !Number.isFinite(num) || num < 0) return '0';
    try { return num.toLocaleString('zh-CN'); }
    catch (err) { return String(num); }
  }

  function syncFileSizeToMonitor(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) {
      writerState.fileSizeBytes = 0;
      monitorState.fileSizeBytes = writerState.handle ? 0 : null;
    } else {
      writerState.fileSizeBytes = bytes;
      monitorState.fileSizeBytes = bytes;
    }
    updateMonitorStatsUI();
  }

  function updateWriterPanel() {
    if (!writerSection) return;
    const hasHandle = !!writerState.handle;
    writerSection.classList.toggle('hidden', !hasHandle);
    if (fileLabelEl) fileLabelEl.textContent = hasHandle ? (writerState.label || '已授权') : '未选择';
    if (writerJobEl) writerJobEl.textContent = writerState.jobId ? String(writerState.jobId) : '—';
    if (writerPixelCountEl) writerPixelCountEl.textContent = formatPixelDisplay();
    if (writerLastUpdateEl) writerLastUpdateEl.textContent = formatTs(writerState.lastWriteTs);
    if (writerStateEl) writerStateEl.textContent = writerState.active ? '写入中' : (hasHandle ? '待命' : '未准备');
    const canStart = hasHandle && !monitorState.jobRunning;
    const canStop = hasHandle || monitorState.jobRunning;
    if (stopWriterBtn) stopWriterBtn.disabled = !canStop;
    if (startJobBtn) startJobBtn.disabled = !canStart;
    syncFileSizeToMonitor(writerState.fileSizeBytes || 0);
  }

  function notifyBackgroundReady(extra = {}) {
    try {
      chrome.runtime.sendMessage(Object.assign({
        type: 'stream-picker-ready',
        sessionId,
        writerActive: writerState.active,
        hasHandle: !!writerState.handle,
        label: writerState.label
      }, extra));
    } catch (err) {
      console.warn('[WPI Picker] notify ready failed', err);
    }
  }

  function postResult(payload, { closeWindow } = {}) {
    const message = Object.assign({ type: 'stream-picker-result', sessionId }, payload || {});
    if (chrome?.runtime?.sendMessage) {
      chrome.runtime.sendMessage(message, () => {
        const lastErr = chrome.runtime.lastError;
        if (lastErr) console.warn('[WPI Picker] runtime send error', lastErr.message || lastErr);
      });
    }
    if (closeWindow) {
      try { window.close(); } catch (err) {}
    }
  }

  async function closeWritable() {
    if (!writerState.writable) return;
    try {
      await writerState.writable.close();
    } catch (err) {
      console.warn('[WPI Picker] close writer error', err);
    } finally {
      writerState.writable = null;
    }
  }

  async function primeWritable() {
    if (!writerState.handle) throw new Error('no-handle');
    await closeWritable();
    writerState.writable = await writerState.handle.createWritable({ keepExistingData: false });
    await writerState.writable.truncate(0);
  }

  async function abortWriter(reason, { silent } = {}) {
    await closeWritable();
    writerState.handle = null;
    writerState.label = '';
    writerState.jobId = null;
    writerState.rowsWritten = 0;
    writerState.lastWriteTs = null;
    writerState.active = false;
    writerState.fileSizeBytes = 0;
    syncFileSizeToMonitor(0);
    updateWriterPanel();
    if (!silent) {
      setStatus('写入已停止，如需继续请重新选择文件', 'error');
    }
    try {
      chrome.runtime.sendMessage({ type: 'stream-writer-aborted', sessionId, reason });
    } catch (err) {
      console.warn('[WPI Picker] notify abort failed', err);
    }
    notifyBackgroundReady();
  }

  async function handlePick() {
    if (!window.WPIStreaming) {
      setStatus('无法加载流式写入模块', 'error');
      postResult({ status: 'error', error: 'missing-streaming' });
      return;
    }
    if (writerState.handle) {
      await abortWriter('reselect', { silent: true });
    }
    pickBtn.disabled = true;
    setStatus('等待文件选择对话框...', '');
    try {
      const res = await window.WPIStreaming.pickVerboseTarget('');
      if (!res || !res.ok) {
        if (res && res.cancelled) {
          setStatus('已取消', '');
          postResult({ status: 'cancelled' });
          return;
        }
        throw new Error(res && res.error ? res.error : 'pick-failed');
      }

      const handle = res.handle;
      if (!handle) throw new Error('missing-handle');
      if (typeof window.WPIStreaming.registerHandle === 'function') {
        await window.WPIStreaming.registerHandle(handle, {
          label: res.label,
          via: res.via,
          permissionGranted: res.permissionGranted !== false
        }).catch(err => {
          console.warn('[WPI Picker] registerHandle failed', err);
        });
      }

      writerState.handle = handle;
      writerState.label = res.label || '选定文件';
      writerState.via = res.via;
      writerState.rowsWritten = 0;
      writerState.jobId = null;
      writerState.active = false;
      writerState.fileSizeBytes = 0;
      syncFileSizeToMonitor(0);
      await primeWritable();
      updateWriterPanel();
      setStatus('已授权，等待后台任务...', 'success');
      postResult({ status: 'success', label: res.label, via: res.via, streaming: true });
      notifyBackgroundReady({ hasHandle: true });
    } catch (err) {
      console.warn('[WPI Picker] pick error', err);
      setStatus('发生错误：' + (err && err.message ? err.message : String(err)), 'error');
      postResult({ status: 'error', error: err && err.message ? err.message : String(err) });
    } finally {
      pickBtn.disabled = false;
    }
  }

  async function handleWriterInit(payload) {
    if (!writerState.handle) throw new Error('no-handle');
    if (!writerState.writable) {
      await primeWritable();
    } else {
      await writerState.writable.seek(0);
      await writerState.writable.truncate(0);
    }
    const header = (payload && payload.header) || '';
    if (header) {
      const text = header.endsWith('\n') ? header : header + '\n';
      const encoded = writerState.encoder.encode(text);
      await writerState.writable.write(encoded);
      writerState.fileSizeBytes = encoded.byteLength;
      syncFileSizeToMonitor(writerState.fileSizeBytes);
    } else {
      writerState.fileSizeBytes = 0;
      syncFileSizeToMonitor(0);
    }
    writerState.jobId = payload.jobId;
    writerState.rowsWritten = 0;
    writerState.lastWriteTs = Date.now();
    writerState.active = true;
    updateWriterPanel();
    setStatus(`任务 #${payload && payload.jobId ? payload.jobId : 'unknown'} 已开始写入`, '');
    notifyBackgroundReady();
    return { ok: true };
  }

  async function handleWriterAppend(payload) {
    if (!writerState.writable || writerState.jobId !== payload.jobId) {
      throw new Error('writer-missing');
    }
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    const chunk = formatVerboseRows(rows);
    if (chunk) {
      const encoded = writerState.encoder.encode(chunk);
      await writerState.writable.write(encoded);
      writerState.rowsWritten += rows.length;
      writerState.lastWriteTs = Date.now();
      writerState.fileSizeBytes += encoded.byteLength;
      syncFileSizeToMonitor(writerState.fileSizeBytes);
      updateWriterPanel();
      setStatus(`写入中：累计 ${writerState.rowsWritten} 行`, '');
    }
    return { ok: true, wrote: rows.length };
  }

  async function handleWriterFinalize(payload) {
    if (writerState.writable) {
      await writerState.writable.close();
      writerState.writable = null;
    }
    writerState.active = false;
    writerState.jobId = null;
    updateWriterPanel();
     setStatus('写入完成，可保持窗口待命或关闭', 'success');
     notifyBackgroundReady();
    return { ok: true };
  }

  function handleRuntimeMessage(msg, sender, sendResponse) {
    if (!msg || msg.type !== 'verbose-writer-command' || msg.sessionId !== sessionId) {
      return false;
    }
    (async () => {
      try {
        let resp;
        if (msg.action === 'init') resp = await handleWriterInit(msg);
        else if (msg.action === 'append') resp = await handleWriterAppend(msg);
        else if (msg.action === 'finalize') resp = await handleWriterFinalize(msg);
        else resp = { ok: false, error: 'unknown-action' };
        sendResponse(resp);
      } catch (err) {
        console.warn('[WPI Picker] writer command failed', msg.action, err);
        if (msg.action !== 'append') {
          writerState.active = false;
          updateWriterPanel();
        }
        setStatus('写入发生异常：' + (err && err.message ? err.message : String(err)), 'error');
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
        notifyBackgroundReady({ writerActive: writerState.active });
      }
    })();
    return true;
  }

  pickBtn?.addEventListener('click', () => {
    handlePick();
  });

  cancelBtn?.addEventListener('click', () => {
    setStatus('已取消', '');
    postResult({ status: 'cancelled' }, { closeWindow: true });
  });

  stopWriterBtn?.addEventListener('click', () => {
    handleStopJob();
  });

  startJobBtn?.addEventListener('click', () => {
    handleStartJob();
  });

  window.addEventListener('keydown', (evt) => {
    if (evt.key === 'Escape' && !writerState.handle) {
      evt.preventDefault();
      postResult({ status: 'cancelled' }, { closeWindow: true });
    }
  });

  chrome?.runtime?.onMessage?.addListener(handleRuntimeMessage);

  if (window.top === window) {
    setStatus('请点击“选择文件”完成授权', '');
    pickBtn?.focus();
  }

  notifyBackgroundReady();
  updateWriterPanel();

  const HEARTBEAT_MS = 15000;
  const heartbeat = setInterval(() => {
    notifyBackgroundReady();
  }, HEARTBEAT_MS);

  const MONITOR_INTERVAL_MS = 2000;
  const monitorTimer = setInterval(() => {
    refreshMonitorFromStorage();
  }, MONITOR_INTERVAL_MS);
  refreshMonitorFromStorage();

  window.addEventListener('beforeunload', () => {
    if (writerState.handle) {
      try { chrome.runtime.sendMessage({ type: 'stream-writer-window-closed', sessionId }); }
      catch (err) { /* ignore */ }
    }
    clearInterval(heartbeat);
    clearInterval(monitorTimer);
  });

  function formatVerboseRows(rows) {
    if (!Array.isArray(rows) || !rows.length) return '';
    const escapeCsvValue = (value) => {
      if (value === null || value === undefined) return '';
      const str = String(value);
      if (!/[",\n]/.test(str)) return str;
      return '"' + str.replace(/"/g, '""') + '"';
    };
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

  function average(arr) {
    if (!arr || !arr.length) return null;
    const sum = arr.reduce((acc, cur) => acc + cur, 0);
    return sum / arr.length;
  }

  function formatDuration(ms) {
    if (!ms || ms <= 0) return '—';
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
  }

  function formatBytes(bytes) {
    if (!bytes || bytes < 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB'];
    let idx = 0;
    let value = bytes;
    while (value >= 1024 && idx < units.length - 1) {
      value /= 1024;
      idx++;
    }
    return `${value.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
  }

  function formatPixelDisplay() {
    const val = (typeof monitorState.doneCoords === 'number' && Number.isFinite(monitorState.doneCoords))
      ? monitorState.doneCoords
      : writerState.rowsWritten;
    return formatCountValue(val || 0);
  }

  async function refreshMonitorFromStorage() {
    const snapshot = await storageGet([STORAGE_KEYS.RUN_STATE, STORAGE_KEYS.PROGRESS, STORAGE_KEYS.JOB_STORE]);
    const runState = unwrapStored(snapshot[STORAGE_KEYS.RUN_STATE], STORAGE_KEYS.RUN_STATE);
    const progress = unwrapStored(snapshot[STORAGE_KEYS.PROGRESS], STORAGE_KEYS.PROGRESS);
    const jobStore = unwrapStored(snapshot[STORAGE_KEYS.JOB_STORE], STORAGE_KEYS.JOB_STORE);

    if (runState && runState.running && runState.startedAt) {
      monitorState.elapsedMs = Math.max(0, Date.now() - Number(runState.startedAt));
      monitorState.jobRunning = true;
    } else {
      monitorState.elapsedMs = 0;
      monitorState.jobRunning = false;
    }

    if (progress) {
      if (typeof progress.total === 'number') {
        monitorState.totalCoords = progress.total;
      }
      if (typeof progress.done === 'number') {
        monitorState.doneCoords = progress.done;
      }
      if (progress.lastBatch && progress.lastBatch.batchDurationMs > 0) {
        monitorState.batchDurations.push(progress.lastBatch.batchDurationMs);
        if (monitorState.batchDurations.length > 10) monitorState.batchDurations.shift();
        if (progress.lastBatch.batchCount > 0) {
          monitorState.batchSizes.push(progress.lastBatch.batchCount);
          if (monitorState.batchSizes.length > 10) monitorState.batchSizes.shift();
        }
      }
    } else if (!monitorState.jobRunning) {
      monitorState.totalCoords = 0;
      monitorState.doneCoords = 0;
      monitorState.batchDurations = [];
      monitorState.batchSizes = [];
    }

    if (jobStore && jobStore._seenIds) {
      const keys = Object.keys(jobStore._seenIds).filter(k => k !== '__noid');
      monitorState.uniqueCount = keys.length;
    } else if (!monitorState.jobRunning) {
      monitorState.uniqueCount = 0;
    }

    monitorState.etaMs = computeEtaMs();
    updateWriterPanel();
  }

  function computeEtaMs() {
    if (!monitorState.jobRunning) return null;
    const remaining = Math.max(0, (monitorState.totalCoords || 0) - (monitorState.doneCoords || 0));
    if (!remaining) return 0;
    const avgBatchDuration = average(monitorState.batchDurations);
    const avgBatchSize = average(monitorState.batchSizes);
    if (!avgBatchDuration || !avgBatchSize) return null;
    const remainingBatches = Math.ceil(remaining / avgBatchSize);
    if (!remainingBatches) return null;
    return remainingBatches * avgBatchDuration;
  }

  function updateMonitorStatsUI() {
    if (writerElapsedEl) writerElapsedEl.textContent = monitorState.elapsedMs ? formatDuration(monitorState.elapsedMs) : (monitorState.jobRunning ? '计时中' : '—');
    if (writerEtaEl) writerEtaEl.textContent = (monitorState.etaMs != null && monitorState.etaMs > 0) ? formatDuration(monitorState.etaMs) : (monitorState.jobRunning ? '计算中' : '—');
    if (writerFileSizeEl) writerFileSizeEl.textContent = monitorState.fileSizeBytes ? formatBytes(monitorState.fileSizeBytes) : (writerState.handle ? '0 B' : '—');
    if (writerUniqueCountEl) writerUniqueCountEl.textContent = monitorState.uniqueCount != null ? String(monitorState.uniqueCount) : '0';
  }

  // file size updates now piggyback on known bytes written via syncFileSizeToMonitor()
  async function handleStartJob() {
    if (!writerState.handle) {
      setStatus('请先完成文件授权后再启动任务。', 'error');
      return;
    }
    if (monitorState.jobRunning) {
      setStatus('任务正在运行中，无需再次启动。', '');
      return;
    }
    if (startJobBtn) startJobBtn.disabled = true;
    try {
      const cfg = await loadLastSettings();
      if (!cfg) {
        throw new Error('未找到保存的配置，请先在主弹窗中设置参数并保存。');
      }
      cfg.VERBOSE_MODE = true;
      if (!cfg.VERBOSE_PATH) cfg.VERBOSE_PATH = writerState.label || 'stream-picker';
      setStatus('正在请求后台启动任务…', '');
      const resp = await sendStartFetch(cfg);
      if (resp && resp.ok) {
        setStatus('后台已开始任务，写入窗口待命。', 'success');
        return;
      }
      if (resp && resp.error === 'already-running') {
        setStatus('检测到已有任务正在运行，尝试先停止再重新启动…', '');
        const stopped = await requestStopAndWait('restart-from-picker');
        if (!stopped) throw new Error('无法停止现有任务，请检查后台状态');
        const retry = await sendStartFetch(cfg);
        if (retry && retry.ok) {
          setStatus('任务已重启。', 'success');
          return;
        }
        throw new Error((retry && retry.error) || 'retry-failed');
      }
      throw new Error((resp && resp.error) || 'start-failed');
    } catch (err) {
      console.warn('[WPI Picker] handleStartJob error', err);
      setStatus('启动任务失败：' + (err && err.message ? err.message : String(err)), 'error');
    } finally {
      if (startJobBtn) startJobBtn.disabled = !(writerState.handle && !monitorState.jobRunning);
    }
  }

  async function handleStopJob() {
    if (stopWriterBtn) stopWriterBtn.disabled = true;
    try {
      setStatus('正在请求后台停止任务…', '');
      const ok = await requestStopAndWait('stop-from-picker');
      if (!ok) {
        setStatus('后台停止未确认，请检查主窗口。', 'error');
      } else {
        setStatus('后台停止完成，写入已关闭。', 'success');
      }
      await abortWriter('user-stopped');
    } catch (err) {
      console.warn('[WPI Picker] handleStopJob error', err);
      setStatus('停止任务失败：' + (err && err.message ? err.message : String(err)), 'error');
    } finally {
      if (stopWriterBtn) stopWriterBtn.disabled = !(writerState.handle || monitorState.jobRunning);
    }
  }

  async function loadLastSettings() {
    const stored = await storageGet([STORAGE_KEYS.SETTINGS]);
    const cfg = stored ? stored[STORAGE_KEYS.SETTINGS] : null;
    if (!cfg) return null;
    try {
      return JSON.parse(JSON.stringify(cfg));
    } catch (err) {
      return Object.assign({}, cfg);
    }
  }

  async function sendStartFetch(cfg) {
    return await new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type: 'start-fetch', cfg }, resp => {
          const lastErr = chrome.runtime.lastError;
          if (lastErr) {
            resolve({ ok: false, error: lastErr.message || 'runtime-error' });
            return;
          }
          resolve(resp || { ok: false, error: 'no-response' });
        });
      } catch (err) {
        resolve({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    });
  }

  async function requestStopAndWait(reason) {
    const stopResp = await sendStopFetch(reason);
    if (!stopResp || !stopResp.ok) {
      return false;
    }
    const cleared = await waitForJobClear();
    return cleared;
  }

  async function sendStopFetch(reason) {
    return await new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type: 'stop-fetch', reason: reason || 'picker-stop' }, resp => {
          const lastErr = chrome.runtime.lastError;
          if (lastErr) {
            resolve({ ok: false, error: lastErr.message || 'runtime-error' });
            return;
          }
          resolve(resp || { ok: false, error: 'no-response' });
        });
      } catch (err) {
        resolve({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    });
  }

  async function waitForJobClear(timeoutMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const snap = await storageGet([STORAGE_KEYS.RUN_STATE, STORAGE_KEYS.JOB_STORE]);
      const runStateRaw = snap[STORAGE_KEYS.RUN_STATE];
      const jobRaw = snap[STORAGE_KEYS.JOB_STORE];
      const runState = unwrapStored(runStateRaw, STORAGE_KEYS.RUN_STATE);
      const jobStore = unwrapStored(jobRaw, STORAGE_KEYS.JOB_STORE);
      const stillRunning = !!(runState && runState.running);
      if (!stillRunning && !jobStore) {
        return true;
      }
      await sleep(400);
    }
    return false;
  }
})();
