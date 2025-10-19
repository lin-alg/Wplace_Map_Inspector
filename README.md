# Wplace_Map_Inspector

- A lightweight browser extension to select a rectangular area on the Wplace map, scan which users painted pixels there, and download the results as a JSONL file. Minimal setup and one-click start/stop. UI in English.
- The extension can scan at a speed of about 3 pixels per second and can run in the background. If you stop the scanning process, it will automatically export the result of the completed part.

---

## Quick Install

1. Download the repository ZIP or clone it: 
git clone <repo_url>   
If you downloaded the ZIP, unzip it before installation.
2. Open Chrome or Edge and go to `chrome://extensions/` or `edge://extensions/`, enable Developer mode.
3. Click **Load unpacked** and choose the repository folder. The extension icon will appear in the toolbar.

Notes:
- Prefer Chrome or Edge for easiest compatibility.
- The extension is designed for jobs of up to 20,000 sampled pixels. To scan larger areas, increase `stepX`/`stepY` to reduce the number of requests.

---

## Quick Start

1. Open the Wplace page.
2. Click the extension icon to open the popup.
3. Fill Start (top-left of the intended area) and End (bottom-right of the intended area) coordinates:
- Start: `startBlockX`, `startBlockY`, `startX`, `startY`
- End: `endBlockX`, `endBlockY`, `endX`, `endY`
4. Set `stepX` / `stepY` to control sampling density (larger step = fewer requests). Default `1` is full resolution.
5. (Optional) Open Advanced to adjust:
- `CONCURRENCY` — number of parallel requests (lower if the server rejects requests).
- `MAX_RPS` — maximum requests per second (lower if the server responds with 429/403).
- `BASE_TEMPLATE` — custom URL template (leave blank for default).
6. Click **Start**. Progress and logs appear in the popup. Click **Stop** to cancel a scan. When finished, a `.txt` file (JSONL format) downloads automatically.
7. To scan a larger area, increase `stepX`/`stepY` rather than attempting a single very large job.
8. Use the included `parse-to-xlsx.html` tool or any converter to transform the JSONL into XLSX (Excel).

---

## UI field reference

- `startBlockX`, `startBlockY`, `startX`, `startY` — top-left coordinate (block + pixel).
- `endBlockX`, `endBlockY`, `endX`, `endY` — bottom-right coordinate (block + pixel).
- `stepX` / `stepY` — sampling step (must be > 0).
- `CONCURRENCY` — number of concurrent fetches per batch (avoid setting too high).
- `MAX_RPS` — maximum requests per second (token-bucket throttling).
- `BASE_TEMPLATE` — optional custom URL template. Use placeholders `{blockX}`, `{blockY}`, `{lx}`, `{ly}`.
- Controls: `Start`, `Stop`, `Clear Log`.

---

## Troubleshooting (common issues)

- Injection blocked / CSP errors: Ensure you are on a supported Wplace URL that matches the extension's host permissions and reload the page.
- No records collected: Confirm the Start/End/step produce at least one coordinate; inspect network requests in the page DevTools to view responses.
- Too many 429/403 errors: Lower `CONCURRENCY` and `MAX_RPS`, increase `BATCH_PAUSE_MS` (if exposed), or increase `stepX`/`stepY`.
- Download didn’t start: Some browsers block automatic downloads from extensions—allow downloads for the extension or check popup logs for blob creation errors.
- Popup unresponsive: Reload the page and reopen the popup; check popup DevTools (right-click → Inspect) for details.

If problems persist, copy the popup log and open an issue with the coordinates used and the log.

---

## Safety and etiquette

- Start with conservative settings and small areas to avoid overloading the remote service.
- Respect the target service’s terms of use and rate limits.
- This tool queries public pixel metadata endpoints; do not use it against private, restricted, or unauthorized services.

---

## Output format

- The downloaded `.txt` file is JSONL: one JSON object per line. Each object contains pixel coordinates and any discovered `paintedBy` metadata. Use the included `parse-to-xlsx` tool or your preferred converter to open the data in Excel.

---

## FAQ

Q: What browsers are supported?  
A: Chromium-based browsers (Chrome, Edge) are recommended for developer-mode installation.

Q: Can I convert the output to Excel?  
A: Yes — use `parse-to-xlsx.html` included in the repo or import the JSONL into spreadsheet software that supports JSON lines.

Q: Will this get me banned?  
A: The tool is intended to operate at modest request rates. You won't be banned if you keep the request rate low(using the default advanced settings).

---

## Contributing

Report issues or open PRs with reproduction steps and logs. 

---

## License

GPL-3.0
