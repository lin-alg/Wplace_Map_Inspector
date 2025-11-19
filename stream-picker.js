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
  const writerRowEl = document.getElementById('writerRowCount');
  const writerLastUpdateEl = document.getElementById('writerLastUpdate');
  const writerStateEl = document.getElementById('writerStateText');
  const stopWriterBtn = document.getElementById('stopWriterBtn');

  const writerState = {
    handle: null,
    label: '',
    via: '',
    writable: null,
    encoder: new TextEncoder(),
    jobId: null,
    rowsWritten: 0,
    lastWriteTs: null,
    active: false
  };

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

  function updateWriterPanel() {
    if (!writerSection) return;
    const hasHandle = !!writerState.handle;
    writerSection.classList.toggle('hidden', !hasHandle);
    if (fileLabelEl) fileLabelEl.textContent = hasHandle ? (writerState.label || '已授权') : '未选择';
    if (writerJobEl) writerJobEl.textContent = writerState.jobId ? String(writerState.jobId) : '—';
    if (writerRowEl) writerRowEl.textContent = String(writerState.rowsWritten || 0);
    if (writerLastUpdateEl) writerLastUpdateEl.textContent = formatTs(writerState.lastWriteTs);
    if (writerStateEl) writerStateEl.textContent = writerState.active ? '写入中' : (hasHandle ? '待命' : '未准备');
    if (stopWriterBtn) stopWriterBtn.disabled = !hasHandle;
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
      await writerState.writable.write(writerState.encoder.encode(text));
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
      await writerState.writable.write(writerState.encoder.encode(chunk));
      writerState.rowsWritten += rows.length;
      writerState.lastWriteTs = Date.now();
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
    abortWriter('user-stopped').catch(err => console.warn('[WPI Picker] abort error', err));
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

  window.addEventListener('beforeunload', () => {
    if (writerState.handle) {
      try { chrome.runtime.sendMessage({ type: 'stream-writer-window-closed', sessionId }); }
      catch (err) { /* ignore */ }
    }
    clearInterval(heartbeat);
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
        pb && (pb.alliance || pb.guild || pb.group || ''),
        pb ? JSON.stringify(pb) : ''
      ];
      return fields.map(escapeCsvValue).join(',');
    });
    return lines.join('\n') + '\n';
  }
})();
