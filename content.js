// content.js - page-side scanner implementation
// 说明：background 会发送 { type: 'runScan', item, options }
// 本脚本需执行页面上的扫描动作并把扫描文本返回：sendResponse({ ok:true, text: '...' })
// 另外保留 grabCoords 接口以供 Pick Start/End 使用

console.log('WPI content.js loaded (scanner)');

function parseBmH(text) {
  if (!text) return null;
  const re = /Tl\s*X\s*[:：]\s*([-\d.]+)[,\)\s]+Tl\s*Y\s*[:：]\s*([-\d.]+)[,\)\s]+Px\s*X\s*[:：]\s*([-\d.]+)[,\)\s]+Px\s*Y\s*[:：]\s*([-\d.]+)/i;
  const m = re.exec(text);
  if (!m) return null;
  return { tlX: Number(m[1]), tlY: Number(m[2]), pxX: Number(m[3]), pxY: Number(m[4]) };
}

/* grabCoords: existing interface for pick */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'grabCoords') {
    try {
      const el = document.getElementById('bm-h');
      const raw = el ? (el.innerText || el.textContent) : null;
      const coords = parseBmH(raw);
      if (!coords) {
        sendResponse({ ok: false, error: 'parse failed', raw });
        return;
      }
      sendResponse({ ok: true, coords });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
    return;
  }

  // runScan: perform the scanner action on the page using item params
  if (msg.type === 'runScan') {
    // Expected item shape: { id, tabId, start:{x,y,blockX,blockY}, end: {...}, meta: {...} }
    (async function handleScan() {
      try {
        const item = msg.item || {};
        // Implement your page-specific scanning logic here.
        // Example minimal scanner:
        // - if page exposes a function to perform scan, call it
        // - otherwise try to collect text from certain DOM selectors between coordinates
        //
        // This example tries three strategies in order and returns the first usable result:
        // 1) If window.__wplace_scan is defined, call it (synchronous or async)
        // 2) If a specific element with id 'scan-output' exists, use its text
        // 3) Fallback: collect document.body.innerText (may be large)
        //
        // Replace this with your actual scan implementation.

        // strategy 1: page-provided scanner hook
        if (typeof window.__wplace_scan === 'function') {
          try {
            const maybe = window.__wplace_scan(item);
            const text = (maybe && maybe.then) ? await maybe : maybe;
            sendResponse({ ok: true, text: String(text || '') });
            return;
          } catch (e) {
            console.warn('content runScan: __wplace_scan failed', e);
          }
        }

        // strategy 2: specific DOM element
        const outEl = document.getElementById('scan-output');
        if (outEl) {
          const t = outEl.innerText || outEl.textContent || '';
          sendResponse({ ok: true, text: String(t) });
          return;
        }

        // strategy 3: fallback whole page text (last resort)
        const fallback = (document.body && (document.body.innerText || document.body.textContent)) || '';
        sendResponse({ ok: true, text: String(fallback) });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    // Indicate synchronous false is not needed because sendResponse is called within same tick or async but we used immediate sendResponse inside async closure; for safety return true if async:
    return true;
  }
});
