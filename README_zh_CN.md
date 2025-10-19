# Wplace_Map_Inspector

- 一个轻量级的浏览器扩展，可以在 Wplace 地图上选择一个矩形区域，扫描哪些用户在该区域绘制过像素，并将结果下载为 JSONL 文件。安装简单，一键开始/停止，界面为英文。
- 本扩展能以大约每秒3像素的速度进行扫描，并可在后台运行。若中途终止，扩展会自动导出已完成部分的结果。
- 你可以加入我们的discord群组：https://discord.gg/9SXj3xMEPr
---

## 快速安装

1. 下载仓库 ZIP 或使用 git 克隆：
git clone <repo_url>  
如果下载的是 ZIP，请先解压再安装扩展。
2. 打开 Chrome 或 Edge，进入 `chrome://extensions/` 或 `edge://extensions/`，启用开发者模式。
3. 点击 **加载已解压的扩展程序**，选择仓库主文件夹。扩展图标会出现在工具栏。

注意事项：
- 推荐使用 Chrome 或 Edge，兼容性最佳。
- 扩展单次只能扫描 20,000 个像素点。若需扫描更大区域，请增大 `stepX`/`stepY` 以减少请求数量。

---

## 快速开始

1. 打开 Wplace 页面。
2. 点击扩展图标打开弹窗。
3. 填写起点（扫描区域的左上角）和终点（扫描区域的右下角）坐标：
- 起点：`startBlockX`, `startBlockY`, `startX`, `startY`
- 终点：`endBlockX`, `endBlockY`, `endX`, `endY`
4. 设置 `stepX` / `stepY` 控制采样密度（步长越大，请求越少）。默认 `1` 为全分辨率。
5. （可选）展开高级设置：
- `CONCURRENCY` — 并发请求数（若服务器拒绝请求请调低）。
- `MAX_RPS` — 每秒最大请求数（若出现 429/403 错误请调低）。
- `BASE_TEMPLATE` — 自定义 URL 模板（留空使用默认）。
6. 点击 **Start**。进度和日志会显示在弹窗中。点击 **Stop** 可取消扫描。完成后会自动下载一个 `.txt` 文件（JSONL 格式）。
7. 若需扫描更大区域，请增大 `stepX`/`stepY`，而不是一次性扫描超大范围。
8. 使用附带的 `parse-to-xlsx.html` 工具或其他转换器，将 JSONL 转换为 XLSX（Excel）。

---

## 界面字段说明

- `startBlockX`, `startBlockY`, `startX`, `startY` — 起点（左上角）坐标（区块 + 像素）。
- `endBlockX`, `endBlockY`, `endX`, `endY` — 终点（右下角）坐标（区块 + 像素）。
- `stepX` / `stepY` — 采样步长（必须 > 0）。
- `CONCURRENCY` — 每批次并发请求数（不要设置过高）。
- `MAX_RPS` — 每秒最大请求数（令牌桶限速）。
- `BASE_TEMPLATE` — 可选的自定义 URL 模板。支持占位符 `{blockX}`, `{blockY}`, `{lx}`, `{ly}`。
- 控件：`Start`、`Stop`、`Clear Log`。

---

## 常见问题排查

- 注入被阻止 / CSP 错误：请确认当前页面是受支持的 Wplace URL，并刷新页面。
- 未收集到记录：确认起点/终点/步长至少生成一个坐标；可在页面 DevTools 中检查网络请求。
- 出现大量 429/403 错误：降低 `CONCURRENCY` 和 `MAX_RPS`，或增大 `stepX`/`stepY`。
- 下载未开始：部分浏览器会阻止扩展自动下载，请允许扩展下载或查看弹窗日志中的错误。
- 弹窗无响应：刷新页面并重新打开弹窗；可在弹窗中右键 → Inspect 打开开发者工具查看详情。

若问题仍然存在，请复制弹窗日志并在 issue 中附上使用的坐标和日志。

---

## 使用安全与规范

- 建议从保守的设置和小区域开始，避免给服务器带来过大压力。
- 遵守目标服务的使用条款和速率限制。
- 本工具仅查询公开的像素元数据接口，请勿用于私有、受限或未授权的服务。

---

## 输出格式

- 下载的 `.txt` 文件为 JSONL 格式：每行一个 JSON 对象。每个对象包含像素坐标及发现的 `paintedBy` 元数据。可使用附带的 `parse-to-xlsx` 工具或其他转换器在 Excel 中打开。

---

## 常见问题 (FAQ)

**Q: 支持哪些浏览器？**  
A: 推荐在基于 Chromium 的浏览器（Chrome、Edge）中以开发者模式安装。

**Q: 可以把结果转换为 Excel 吗？**  
A: 可以 — 使用仓库附带的 `parse-to-xlsx.html`，或将 JSONL 导入支持 JSON Lines 的表格软件。

**Q: 会不会被封禁？**  
A: 工具设计为以较低的请求速率运行。只要保持请求速率较低（使用默认高级设置），一般不会被封禁。

**Q: 这个扩展的图标从哪里来？**  
A: 这来自国内一个Wplace群组，你可以加入我们的discord：https://discord.gg/9SXj3xMEPr 

---

## 贡献

欢迎提交 issue 或 PR，并附上复现步骤和日志。

---

## 许可证

GPL-3.0
