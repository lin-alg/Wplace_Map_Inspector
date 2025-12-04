'use strict';

(function(){
  const BLOCK_SIZE = 1000;
  const MAX_CANVAS_DIM = 4096;
  const legendList = document.getElementById('legendList');
  const fileInput = document.getElementById('verboseFile');
  const filePicker = document.getElementById('filePicker');
  const fileNameEl = document.getElementById('fileName');
  const renderBtn = document.getElementById('renderBtn');
  const downloadBtn = document.getElementById('downloadBtn');
  const canvas = document.getElementById('previewCanvas');
  const statusText = document.getElementById('statusText');
  const statsBar = document.getElementById('statsBar');
  const snapshotCoord = document.getElementById('snapshotCoord');
  const colorPickerOverlay = document.getElementById('colorPickerOverlay');
  const colorPickerPanel = document.getElementById('colorPickerPanel');
  const colorPickerTitle = document.getElementById('colorPickerTitle');
  const colorPickerHint = document.getElementById('colorPickerHint');
  const closeColorPickerBtn = document.getElementById('closeColorPickerBtn');
  const colorHexInput = document.getElementById('colorHexInput');
  const colorNativeInput = document.getElementById('colorNativeInput');
  const paletteGrid = document.getElementById('pickerPaletteGrid');
  const defaultColorBtn = document.getElementById('defaultColorBtn');
  const cancelColorBtn = document.getElementById('cancelColorBtn');
  const applyColorBtn = document.getElementById('applyColorBtn');
  const ctx = canvas.getContext('2d');

  if (canvas) {
    canvas.style.imageRendering = 'pixelated';
  }
  if (ctx) {
    ctx.imageSmoothingEnabled = false;
    ctx.imageSmoothingQuality = 'low';
  }

  const COLOR_PICKER_PALETTE = [
    '#000000', '#3C3C3C', '#787878', '#AAAAAA', '#D2D2D2', '#FFFFFF', '#600018', '#A50E1E',
    '#ED1C24', '#FA8072', '#E45C1A', '#FF7F27', '#F6AA09', '#F9DD3B', '#FFFABC', '#9C8431',
    '#C5AD31', '#E8D45F', '#4A6B3A', '#5A944A', '#84C573', '#0EB968', '#13E67B', '#87FF5E',
    '#0C816E', '#10AEA6', '#13E1BE', '#0F799F', '#60F7F2', '#BBFAF2', '#28509E', '#4093E4',
    '#7DC7FF', '#4D31B8', '#6B50F6', '#99B1FB', '#4A4284', '#7A71C4', '#B5AEF1', '#780C99',
    '#AA38B9', '#E09FF9', '#CB007A', '#EC1F80', '#F38DA9', '#9B5249', '#D18078', '#FAB6A4',
    '#684634', '#95682A', '#DBA463', '#7B6352', '#9C846B', '#D6B594', '#D18051', '#F8B277',
    '#FFC5A5', '#6D643F', '#948C6B', '#CDC59E', '#333941', '#6D758D', '#B3B9D1', 'transparent'
  ];

  let currentFile = null;
  let lastRenderInfo = null;
  const userColorOverrides = new Map();
  let activeColorContext = null;
  let stagedColorValue = null;
  let syncingPickerInputs = false;

  function setStatus(text, type) {
    statusText.textContent = text;
    statusText.className = 'status' + (type ? ' ' + type : '');
  }

  function formatNumber(num) {
    if (!Number.isFinite(num)) return '0';
    try { return num.toLocaleString('zh-CN'); }
    catch (err) { return String(num); }
  }

  function hashColorKey(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return hash;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function hslToHex(h, s, l) {
    const hue = ((h % 360) + 360) % 360;
    const sat = clamp(s, 0, 100) / 100;
    const light = clamp(l, 0, 100) / 100;
    const c = (1 - Math.abs(2 * light - 1)) * sat;
    const hp = hue / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    let r = 0, g = 0, b = 0;
    if (hp >= 0 && hp < 1) { r = c; g = x; }
    else if (hp < 2) { r = x; g = c; }
    else if (hp < 3) { g = c; b = x; }
    else if (hp < 4) { g = x; b = c; }
    else if (hp < 5) { r = x; b = c; }
    else { r = c; b = x; }
    const m = light - c / 2;
    const rgb = [r, g, b].map(component => clamp(Math.round((component + m) * 255), 0, 255)
      .toString(16).padStart(2, '0'));
    return `#${rgb.join('')}`;
  }

  function normalizeHex(value) {
    if (typeof value !== 'string') return null;
    let hex = value.trim();
    if (!hex.length) return null;
    if (hex.startsWith('#')) hex = hex.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      hex = hex.split('').map(ch => ch + ch).join('');
    }
    if (hex.length !== 6) return null;
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
    return `#${hex.toLowerCase()}`;
  }

  function isTransparentColor(value) {
    return typeof value === 'string' && value.toLowerCase() === 'transparent';
  }

  function toBlockCoord(globalValue) {
    const block = Math.floor(globalValue / BLOCK_SIZE);
    const local = globalValue - (block * BLOCK_SIZE);
    return { block, local };
  }

  function computeTopLeftCoord(data) {
    if (!data) return null;
    const xInfo = toBlockCoord(data.minGX);
    const yInfo = toBlockCoord(data.minGY);
    return {
      blockX: xInfo.block,
      blockY: yInfo.block,
      x: xInfo.local,
      y: yInfo.local
    };
  }

  function formatCoordLabel(coord) {
    if (!coord) return 'BlockX ?, BlockY ?, x ?, y ?';
    return `${coord.blockX}, ${coord.blockY}, ${coord.x}, ${coord.y}`;
  }

  function formatCoordFilename(coord) {
    if (!coord) return 'snapshot';
    return `${coord.blockX}, ${coord.blockY}, ${coord.x}, ${coord.y}`;
  }

  function updateSnapshotCoordDisplay(coord) {
    if (!snapshotCoord) return;
    snapshotCoord.textContent = formatCoordLabel(coord);
  }

  function createColorAllocator() {
    const assignments = new Map();
    const usedColors = new Set();
    const GOLDEN_ANGLE = 137.50776405003785;
    const basePalette = [
      '#ff6b6b', '#ffa94d', '#ffd93d', '#6bcb77', '#4d96ff', '#9d4edd', '#f06595', '#0dcaf0',
      '#f28482', '#ef476f', '#118ab2', '#06d6a0', '#ffe066', '#8338ec', '#ff9f1c', '#2ec4b6',
      '#ff0a54', '#8ac926', '#f77f00', '#3a86ff', '#bc6ff1', '#06bcee', '#c9f4aa', '#ff6f91'
    ];
    const dynamicSeed = (Math.random() * 360) % 360;
    let paletteIndex = 0;

    function nextPaletteColor() {
      while (paletteIndex < basePalette.length) {
        const color = basePalette[paletteIndex++].toLowerCase();
        if (!usedColors.has(color)) {
          usedColors.add(color);
          return color;
        }
      }

      let attempt = 0;
      while (attempt < 720) {
        const hue = (dynamicSeed + (paletteIndex + attempt) * GOLDEN_ANGLE) % 360;
        const saturation = clamp(68 + 18 * Math.sin((paletteIndex + attempt) * 0.8), 55, 86);
        const lightness = clamp(52 + 16 * Math.cos((paletteIndex + attempt) * 0.6), 38, 72);
        const candidate = hslToHex(Math.round(hue), Math.round(saturation), Math.round(lightness));
        attempt++;
        if (!usedColors.has(candidate)) {
          usedColors.add(candidate);
          paletteIndex++;
          return candidate;
        }
      }

      const fallbackHue = (dynamicSeed + usedColors.size * 53) % 360;
      const fallback = hslToHex(Math.round(fallbackHue), 70, 55);
      usedColors.add(fallback);
      paletteIndex++;
      return fallback;
    }

    return function getColorForKey(key) {
      if (assignments.has(key)) return assignments.get(key);
      const color = nextPaletteColor();
      assignments.set(key, color);
      return color;
    };
  }

  function parseCsvLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    result.push(current);
    return result.map(v => v.trim());
  }

  function parseVerboseCsv(text) {
    const lines = (text || '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length);
    if (!lines.length) throw new Error('文件为空或格式不正确');

    let startIdx = 0;
    const header = parseCsvLine(lines[0]);
    const hasHeader = header && header[0] && /blockx/i.test(header[0]);
    if (hasHeader) startIdx = 1;

    const points = [];
    const getColorForKey = createColorAllocator();
    const userStats = new Map();
    let minGX = Infinity, maxGX = -Infinity;
    let minGY = Infinity, maxGY = -Infinity;

    for (let i = startIdx; i < lines.length; i++) {
      const row = parseCsvLine(lines[i]);
      if (!row.length) continue;
      const blockX = Number(row[0]);
      const blockB = Number(row[1]);
      const x = Number(row[2]);
      const y = Number(row[3]);
      if (!Number.isFinite(blockX) || !Number.isFinite(blockB) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
      const gx = Math.round(blockX * BLOCK_SIZE + x);
      const gy = Math.round(blockB * BLOCK_SIZE + y);
      const rawId = (row[4] || '').trim();
      const rawName = (row[5] || '').trim();
      const key = rawId || rawName || 'unknown';
      const label = rawName || (rawId ? `ID ${rawId}` : '未识别');
      const baseColor = getColorForKey(key);
      const overrideColor = userColorOverrides.get(key);
      const color = overrideColor || baseColor;
      points.push({ gx, gy, key, label, color, baseColor });
      if (gx < minGX) minGX = gx;
      if (gx > maxGX) maxGX = gx;
      if (gy < minGY) minGY = gy;
      if (gy > maxGY) maxGY = gy;
      if (!userStats.has(key)) {
        userStats.set(key, { key, label, baseColor, color: overrideColor || baseColor, count: 0 });
      }
      const statsEntry = userStats.get(key);
      if (!statsEntry.baseColor) statsEntry.baseColor = baseColor;
      statsEntry.color = overrideColor || statsEntry.baseColor;
      statsEntry.count++;
    }

    if (!points.length) throw new Error('未能解析出任何像素，请确认文件内容');

    return {
      points,
      userStats,
      minGX,
      maxGX,
      minGY,
      maxGY
    };
  }

  function applyColorOverrides(data) {
    if (!data) return;
    for (const pt of data.points) {
      const override = userColorOverrides.get(pt.key);
      pt.color = override || pt.baseColor;
    }
    data.userStats.forEach(entry => {
      const override = userColorOverrides.get(entry.key);
      entry.color = override || entry.baseColor;
    });
  }

  function drawPoints(data) {
    const spanX = (data.maxGX - data.minGX) + 1;
    const spanY = (data.maxGY - data.minGY) + 1;
    const maxSpan = Math.max(spanX, spanY);
    const scale = maxSpan > MAX_CANVAS_DIM ? (MAX_CANVAS_DIM / maxSpan) : 1;
    const width = Math.max(1, Math.round(spanX * scale));
    const height = Math.max(1, Math.round(spanY * scale));

    canvas.width = width;
    canvas.height = height;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#05070f';
    ctx.fillRect(0, 0, width, height);

    const pixelSize = Math.max(1, scale);
    const warnDownscale = scale < 1;

    for (const pt of data.points) {
      const drawX = (pt.gx - data.minGX) * scale;
      const drawY = (pt.gy - data.minGY) * scale;
      ctx.fillStyle = pt.color;
      ctx.fillRect(drawX, drawY, pixelSize, pixelSize);
    }

    return { width, height, scale, warnDownscale };
  }

  function refreshAfterColorChange() {
    if (!lastRenderInfo?.stats) return;
    applyColorOverrides(lastRenderInfo.stats);
    const meta = drawPoints(lastRenderInfo.stats);
    renderLegend(lastRenderInfo.stats.userStats);
    lastRenderInfo.scale = meta.scale;
  }

  function renderLegend(userStats) {
    legendList.innerHTML = '';
    const sorted = Array.from(userStats.values()).sort((a, b) => b.count - a.count);
    sorted.forEach(item => {
      const row = document.createElement('div');
      row.className = 'legend-item';
      const swatch = document.createElement('span');
      swatch.className = 'legend-color';
      swatch.dataset.userKey = item.key;
      swatch.dataset.userLabel = item.label;
      swatch.dataset.defaultColor = item.baseColor || '';
      swatch.tabIndex = 0;
      swatch.setAttribute('role', 'button');
      swatch.setAttribute('aria-label', `${item.label} 的颜色`);
      swatch.style.background = isTransparentColor(item.color) ? 'transparent' : (item.color || '#ffffff');
      if (isTransparentColor(item.color)) {
        swatch.classList.add('transparent');
      } else {
        swatch.classList.remove('transparent');
      }
      const label = document.createElement('span');
      label.textContent = `${item.label} · ${formatNumber(item.count)} px`;
      row.appendChild(swatch);
      row.appendChild(label);
      legendList.appendChild(row);
    });
    if (!sorted.length) {
      const empty = document.createElement('div');
      empty.className = 'legend-item';
      empty.textContent = '暂无数据';
      legendList.appendChild(empty);
    }
  }

  function updateStatsBar(stats) {
    statsBar.innerHTML = '';
    const entries = [
      { label: '像素数', value: formatNumber(stats.pixelCount) },
      { label: '用户数', value: formatNumber(stats.userCount) },
      { label: '宽度', value: `${formatNumber(stats.spanX)} px` },
      { label: '高度', value: `${formatNumber(stats.spanY)} px` }
    ];
    entries.forEach(item => {
      const block = document.createElement('div');
      block.className = 'stat-block';
      block.innerHTML = `<div>${item.label}</div><strong>${item.value}</strong>`;
      statsBar.appendChild(block);
    });
  }

  async function handleRender() {
    if (!currentFile) return;
    try {
      setStatus('正在读取文件…');
      const text = await currentFile.text();
      const parsed = parseVerboseCsv(text);
      applyColorOverrides(parsed);
      setStatus('正在绘制 PNG…');
      const meta = drawPoints(parsed);
      renderLegend(parsed.userStats);
      const topLeftCoord = computeTopLeftCoord(parsed);
      updateSnapshotCoordDisplay(topLeftCoord);
      updateStatsBar({
        pixelCount: parsed.points.length,
        userCount: parsed.userStats.size,
        spanX: (parsed.maxGX - parsed.minGX) + 1,
        spanY: (parsed.maxGY - parsed.minGY) + 1
      });
      downloadBtn.disabled = false;
      lastRenderInfo = {
        fileName: formatCoordFilename(topLeftCoord),
        topLeftCoord,
        stats: parsed,
        scale: meta.scale
      };
      if (meta.warnDownscale) {
        setStatus('注意：图像较大，已按比例压缩，可缩小选择区域以获得原始分辨率。', '');
      } else {
        setStatus('转换完成，可预览并下载 PNG。', 'success');
      }
    } catch (err) {
      console.warn('[VerbosePNG] render failed', err);
      downloadBtn.disabled = true;
      legendList.innerHTML = '';
      updateSnapshotCoordDisplay(null);
      setStatus(err.message || '解析失败', 'error');
    }
  }

  function handleDownload() {
    if (!lastRenderInfo) return;
    try {
      const link = document.createElement('a');
      link.href = canvas.toDataURL('image/png');
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const baseName = lastRenderInfo.fileName || 'verbose';
      link.download = `${baseName}_${ts}.png`;
      link.click();
    } catch (err) {
      console.warn('[VerbosePNG] download error', err);
      setStatus('无法导出 PNG，请重试。', 'error');
    }
  }

  function updatePickerHint(color) {
    if (!colorPickerHint) return;
    if (!color) {
      colorPickerHint.textContent = '选择颜色后点击应用';
    } else if (isTransparentColor(color)) {
      colorPickerHint.textContent = '当前颜色：透明（不会绘制像素）';
    } else {
      colorPickerHint.textContent = `当前颜色：${color.toUpperCase()}`;
    }
  }

  function syncPickerInputs(color) {
    if (!colorHexInput || !colorNativeInput) return;
    syncingPickerInputs = true;
    if (isTransparentColor(color)) {
      colorHexInput.value = '';
      colorHexInput.classList.add('is-transparent');
      colorNativeInput.value = '#000000';
      updatePickerHint('transparent');
    } else {
      const normalized = normalizeHex(color || '') || '';
      colorHexInput.value = normalized;
      colorHexInput.classList.remove('is-transparent');
      colorNativeInput.value = normalized ? normalized.slice(0, 7) : '#000000';
      updatePickerHint(normalized || null);
    }
    syncingPickerInputs = false;
  }

  function stageColorSelection(color) {
    if (isTransparentColor(color)) {
      stagedColorValue = 'transparent';
      syncPickerInputs('transparent');
      return true;
    }
    const normalized = normalizeHex(color || '');
    if (!normalized) return false;
    stagedColorValue = normalized;
    syncPickerInputs(normalized);
    return true;
  }

  function openColorPicker(userKey, label) {
    if (!colorPickerOverlay || !lastRenderInfo?.stats) return;
    const statsEntry = lastRenderInfo.stats.userStats.get(userKey);
    if (!statsEntry) return;
    const defaultColor = normalizeHex(statsEntry.baseColor || '') || statsEntry.baseColor || '#ff6b6b';
    activeColorContext = { key: userKey, label, defaultColor };
    const currentColor = userColorOverrides.get(userKey) || statsEntry.color || defaultColor;
    if (!stageColorSelection(currentColor || defaultColor)) {
      stageColorSelection(defaultColor);
    }
    colorPickerTitle.textContent = `调整 ${label} 的颜色`;
    colorPickerOverlay.classList.add('active');
    colorPickerOverlay.setAttribute('aria-hidden', 'false');
    setTimeout(() => colorHexInput?.focus(), 0);
  }

  function closeColorPicker() {
    if (!colorPickerOverlay) return;
    colorPickerOverlay.classList.remove('active');
    colorPickerOverlay.setAttribute('aria-hidden', 'true');
    activeColorContext = null;
    stagedColorValue = null;
    if (colorHexInput) {
      colorHexInput.value = '';
      colorHexInput.classList.remove('is-transparent');
    }
    if (colorNativeInput) {
      colorNativeInput.value = '#ff6b6b';
    }
    updatePickerHint(null);
  }

  function handlePaletteClick(event) {
    const swatch = event.target.closest('.palette-swatch');
    if (!swatch || swatch.classList.contains('empty')) return;
    const color = swatch.dataset.color;
    if (!color) return;
    stageColorSelection(color);
  }

  function handleLegendInteraction(event) {
    const swatch = event.target.closest('.legend-color');
    if (!swatch) return;
    if (event.type === 'keydown') {
      if (!['Enter', ' ', 'Space', 'Spacebar'].includes(event.key)) return;
      event.preventDefault();
    }
    const key = swatch.dataset.userKey;
    if (!key) return;
    const label = swatch.dataset.userLabel || key;
    openColorPicker(key, label);
  }

  function handleApplyColor() {
    if (!activeColorContext || !lastRenderInfo?.stats) return;
    let selected = stagedColorValue;
    if (!selected && colorHexInput?.value) {
      selected = normalizeHex(colorHexInput.value);
    }
    if (!selected) {
      setStatus('请输入合法的 Hex 颜色，例如 #FFAA33。', 'error');
      return;
    }
    const key = activeColorContext.key;
    const normalizedDefault = normalizeHex(activeColorContext.defaultColor || '') || activeColorContext.defaultColor;
    if (isTransparentColor(selected)) {
      userColorOverrides.set(key, 'transparent');
    } else {
      const normalizedSelection = normalizeHex(selected);
      if (!normalizedSelection) {
        setStatus('请输入合法的 Hex 颜色，例如 #FFAA33。', 'error');
        return;
      }
      if (normalizedDefault && normalizedSelection === normalizedDefault) {
        userColorOverrides.delete(key);
      } else {
        userColorOverrides.set(key, normalizedSelection);
      }
    }
    refreshAfterColorChange();
    setStatus('颜色已更新。', 'success');
    closeColorPicker();
  }

  function handleResetColor() {
    if (!activeColorContext) return;
    userColorOverrides.delete(activeColorContext.key);
    refreshAfterColorChange();
    setStatus('颜色已恢复默认。', 'success');
    closeColorPicker();
  }

  function buildPaletteGrid() {
    if (!paletteGrid || paletteGrid.childElementCount) return;
    COLOR_PICKER_PALETTE.forEach((color, idx) => {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'palette-swatch';
      swatch.dataset.index = String(idx);
      swatch.dataset.color = color || '';
      if (!color) {
        swatch.classList.add('empty');
      } else if (isTransparentColor(color)) {
        swatch.classList.add('transparent');
      } else {
        swatch.style.background = color;
      }
      paletteGrid.appendChild(swatch);
    });
    paletteGrid.addEventListener('click', handlePaletteClick);
  }

  function attachPickerEvents() {
    if (!filePicker) return;
    filePicker.addEventListener('click', () => {
      fileInput?.click();
    });
    filePicker.addEventListener('dragover', (e) => {
      e.preventDefault();
      filePicker.style.borderColor = '#8bb5ff';
    });
    filePicker.addEventListener('dragleave', () => {
      filePicker.style.borderColor = 'rgba(255,255,255,0.3)';
    });
    filePicker.addEventListener('drop', (e) => {
      e.preventDefault();
      filePicker.style.borderColor = 'rgba(255,255,255,0.3)';
      if (e.dataTransfer?.files?.length) {
        loadFile(e.dataTransfer.files[0]);
      }
    });
  }

  function loadFile(file) {
    if (!file) return;
    userColorOverrides.clear();
    closeColorPicker();
    currentFile = file;
    fileNameEl.textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB`;
    renderBtn.disabled = false;
    downloadBtn.disabled = true;
    lastRenderInfo = null;
    updateSnapshotCoordDisplay(null);
    setStatus('文件已载入，点击“解析并生成”开始转换。');
  }

  fileInput?.addEventListener('change', (e) => {
    const file = e.target?.files?.[0];
    loadFile(file);
  });

  renderBtn?.addEventListener('click', () => {
    renderBtn.disabled = true;
    handleRender().finally(() => {
      renderBtn.disabled = !currentFile;
    });
  });

  downloadBtn?.addEventListener('click', handleDownload);

  legendList?.addEventListener('click', handleLegendInteraction);
  legendList?.addEventListener('keydown', handleLegendInteraction);

  colorHexInput?.addEventListener('input', (e) => {
    if (syncingPickerInputs) return;
    const normalized = normalizeHex(e.target.value);
    if (normalized) {
      stagedColorValue = normalized;
      syncPickerInputs(normalized);
    } else {
      stagedColorValue = null;
      updatePickerHint(null);
    }
  });

  colorNativeInput?.addEventListener('input', (e) => {
    if (syncingPickerInputs) return;
    stageColorSelection(e.target.value);
  });

  applyColorBtn?.addEventListener('click', handleApplyColor);
  cancelColorBtn?.addEventListener('click', closeColorPicker);
  defaultColorBtn?.addEventListener('click', handleResetColor);
  closeColorPickerBtn?.addEventListener('click', closeColorPicker);

  colorPickerOverlay?.addEventListener('click', (e) => {
    if (e.target === colorPickerOverlay) closeColorPicker();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && colorPickerOverlay?.classList.contains('active')) {
      closeColorPicker();
    }
  });

  attachPickerEvents();
  buildPaletteGrid();
  updateSnapshotCoordDisplay(null);
  setStatus('准备就绪，上传 verbose CSV 开始转换。');
})();
