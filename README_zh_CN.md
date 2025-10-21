# Wplace_Map_Inspector（中文版说明）

一个轻量级的 Chromium 扩展，选取 Wplace 地图上的矩形区域，扫描该区域中哪些用户绘制过像素，结果导出为 JSONL。安装与使用简单，支持后台运行与一键开始/停止，并提供页面内可拖拽的快捷按钮与小巧面板。

---

## 快速安装

- 推荐浏览器：**Chrome / Edge（Chromium）**（未测试 过Firefox）。
- 两种安装方式：
  1. 使用打包的 .crx：打开 chrome://extensions 或 edge://extensions，直接将 .crx 拖入安装。
  2. 开发者模式加载：克隆或解压仓库，打开扩展页 → 启用“开发者模式” → 点击 **Load unpacked** 并选择仓库根目录。

注意：
- 默认适用于最多 **20,000** 个采样点；若扫描更大区域请增大 `stepX` / `stepY` 来减少请求数。
- “拾取坐标”功能需要配合其它页面插件（如 Blue Marble）才能自动填充坐标。

---

## 快速开始

1. 打开 Wplace 页面。  
2. 在页面右下角点击蓝色快捷按钮 “WPI” 打开面板（可拖拽）。  
3. 填写扫描区域坐标（左上 = Start，右下 = End）：  
   - Start：`startBlockX`、`startBlockY`、`startX`、`startY`  
   - End：`endBlockX`、`endBlockY`、`endX`、`endY`  
4. 设置采样密度 `stepX` / `stepY`（步长越大，请求越少；默认 `1` 为全分辨率）。  
5. （可选）打开 Advanced 调整：`CONCURRENCY`、`MAX_RPS`、`BATCH_SIZE`、`BATCH_DELAY_MINUTES`、`BASE_TEMPLATE`。  
6. 点击 **Start** 开始扫描；点击 **Stop** 取消。进度与日志在面板显示。任务完成或停止后会**自动导出** JSONL (.txt) 文件。  
7. 若需 Excel：使用仓库内的 `parse-to-xlsx.html` 将 JSONL 转为 XLSX，或用支持 JSON Lines 的工具导入。

---

## 界面字段与高级设置（要点）

- **坐标相关**
  - **startBlockX / startBlockY / startX / startY**：起点（左上，区块 + 像素）。  
  - **endBlockX / endBlockY / endX / endY**：终点（右下，区块 + 像素）。  
  - 像素坐标会做归一化（超出 BLOCK_SIZE 会进位到区块），面板会估算总采样点数。

- **采样与并发**
  - **stepX / stepY**：步长，必须 > 0，控制采样密度（增大可显著减少请求）。  
  - **CONCURRENCY**：每批并发请求数（过高会引发 429/403）。  
  - **MAX_RPS**：每秒最大请求数（令牌桶限速）。  

- **批次与模板**
  - **BATCH_SIZE / BATCH_DELAY_MINUTES**：分批执行与每批间暂停（后端友好）。  
  - **BASE_TEMPLATE**：自定义请求 URL 模板；支持占位符 `{blockX}`、`{blockB}`（或 `{blockY}`）、`{lx}`、`{ly}`，留空使用默认后端接口。

- **控件**
  - **Start / Stop / Clear Log / Pick start / Pick end**。  
  - 快捷按钮支持最小化、面板内最小化与隐藏（隐藏后快捷按钮保留）。

---

## 输出格式与工具

- 导出文件：`.txt`（JSONL），每行一个 JSON 对象，包含像素坐标与 `paintedBy` 元数据（已去除大体积字段如头像数据）。  
- 提供工具：`parse-to-xlsx.html` — 将 JSONL 解析并导出为 Excel（XLSX）。该工具会对 `paintedBy.id` 去重并生成常用字段列（id、name、alliance 等）。

---

## 故障排查与使用建议

- 注入被阻止 / CSP 错误：确认页面 URL 与扩展权限匹配，刷新页面后重试。  
- 未收集到记录：检查起点/终点/步长是否至少生成一个坐标；在 DevTools Network 查看请求与响应。  
- 出现大量 429 / 403：降低 **CONCURRENCY** 与 **MAX_RPS**，或增大 `stepX`/`stepY` 与 `BATCH_DELAY_MINUTES`。脚本在检测到高错误率时会尝试自动降速。  
- 弹窗无响应 / 快捷按钮不工作：刷新页面；若面板最小化并隐藏，可点击页面右下的 WPI 按钮恢复（若按钮丢失，刷新页面重新创建）。  
- 下载被阻止：浏览器可能限制扩展下载，允许扩展下载或查看面板日志以排查导出失败。

建议：
- 从小范围、保守速率开始测试，确认行为正常后再逐步扩大范围。尊重目标服务条款与速率限制，仅访问公开像素元数据接口。

---

## 贡献与许可

- 欢迎提交 issue / PR，请附上可复现步骤与面板日志。社区讨论群（Discord）：https://discord.gg/9SXj3xMEPr  
- 许可证：**GPL-3.0**

---
