# Wplace_Map_Inspector

A lightweight Chromium extension that selects a rectangular area on the Wplace map, scans which users painted the pixels in that area, and exports results as a JSONL file. Minimal setup, one-click start/stop, background-friendly, and a compact in-page floating quick button for convenience.

---

## Quick Install

1. Clone or download the repository:  
   `git clone <repo_url>`  
   If you downloaded a ZIP, unzip it first.
2. Open Chrome or Edge and go to `chrome://extensions/` or `edge://extensions/`, enable Developer mode.
3. Click **Load unpacked** and choose the repository folder. The extension icon will appear in the toolbar.

Notes:
- Use Chromium-based browsers (Chrome or Edge) for easiest compatibility.
- The extension is tuned for jobs up to ~20,000 sampled pixels. For larger scans, increase `stepX`/`stepY` to reduce request count.

---

## Quick Start

1. Open the Wplace page.
2. Click the extension icon or the page's blue quick button ("WPI") to open the panel.
3. Fill Start (top-left) and End (bottom-right) coordinates:
   - Start: `startBlockX`, `startBlockY`, `startX`, `startY`
   - End: `endBlockX`, `endBlockY`, `endX`, `endY`
4. Set `stepX` / `stepY` to control sampling density (larger value = fewer requests). Default `1` = full resolution.
5. (Optional) Open Advanced to adjust concurrency, rate limits, batch sizing, and URL template.
6. Click **Start** to begin scanning. Click **Stop** to cancel. Progress and logs appear in the panel. When finished or stopped, the collected results are exported automatically as a JSONL `.txt` file.
7. To convert JSONL to Excel, use the included `parse-to-xlsx.html` or any tool that supports JSON Lines.

---

## Panel & Quick Button Behavior (updated)

- Page quick button:
  - A draggable blue button labeled "WPI" sits at the page bottom-right.
  - Dragging the button will not accidentally open the panel; drag actions suppress the subsequent click to prevent accidental toggles.
  - If the panel is closed, the quick button is (re)created and event handlers re-bound to ensure it remains functional.
- Panel minimization:
  - The panel has a no-border minimize control rendered as a long dash.
  - Minimize supports two levels: collapse to a compact mini state inside the host, and fully hide the panel leaving the quick button visible.
  - Keyboard accessible (focusable) while using a minimal visual footprint.
- Pick coordinates:
  - "Pick start" / "Pick end" first tries to parse coordinates from page elements (e.g., an element with `id="bm-h"`), and falls back to a background message request if needed.

---

## UI Field Reference

- `startBlockX` / `startBlockY` / `startX` / `startY` — top-left coordinate (block + pixel).
- `endBlockX` / `endBlockY` / `endX` / `endY` — bottom-right coordinate (block + pixel).
- `stepX` / `stepY` — sampling step (must be > 0).
- `CONCURRENCY` — number of concurrent fetches per batch.
- `MAX_RPS` — maximum requests per second (internal token-bucket throttling).
- `BATCH_SIZE` / `BATCH_DELAY_MINUTES` — batch sizing / pause controls.
- `BASE_TEMPLATE` — optional custom URL template, supports `{blockX}`, `{blockY}`, `{lx}`, `{ly}` placeholders.
- Controls: `Start`, `Stop`, `Clear Log`, `Pick start`, `Pick end`.

---

## Output & Tools

- Export format: `.txt` (JSONL) with one JSON object per line containing pixel coordinates and discovered `paintedBy` metadata.
- Use the included `parse-to-xlsx.html` to convert JSONL to XLSX or any JSON Lines–capable tool.

---

## Troubleshooting

- Injection blocked / CSP errors: ensure the page URL matches extension host permissions and reload the page.
- No records collected: confirm start/end/step produce at least one coordinate; inspect network requests in DevTools for responses.
- Too many 429/403: lower `CONCURRENCY` and `MAX_RPS`, increase `stepX`/`stepY`, or increase batch pause.
- Popup or panel unresponsive: reload the page and reopen the popup; check DevTools console for errors.
- Quick button not responding after hide: refresh the page to allow the script to recreate and rebind the quick button; check console for errors if the issue persists.
- Download blocked: allow downloads for the extension or inspect logs for blob/export errors.

---

## Safety & Etiquette

- Start with conservative settings and small areas to avoid overloading the target service.
- Respect the target service’s terms of use and rate limits.
- Only query public pixel metadata endpoints; do not use the tool against private or unauthorized services.

---

## Contributing

Report issues or open PRs with reproduction steps and panel logs. Community Discord: `https://discord.gg/9SXj3xMEPr`.

---

## License

GPL-3.0
