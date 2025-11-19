'use strict';

(() => {
  const EVENT_NAME = 'wpi-coords';
  if (window.__WPI_FETCH_TAP_INSTALLED__ || typeof window.fetch !== 'function') {
    return;
  }
  window.__WPI_FETCH_TAP_INSTALLED__ = true;

  const originalFetch = window.fetch;
  window.fetch = async function patchedFetch(...args) {
    const response = await originalFetch.apply(this, args);
    try {
      const req = args[0];
      const url = req instanceof Request ? req.url : req;
      if (typeof url === 'string' && url.includes('/pixel/')) {
        const cleanUrl = url.split('#')[0];
        const [pathPart, queryPart = ''] = cleanUrl.split('?');
        const segments = pathPart.split('/').filter(Boolean);
        const len = segments.length;
        const tlX = Number(segments[len - 2]);
        const tlY = Number(segments[len - 1]);
        const params = new URLSearchParams(queryPart);
        const pxX = Number(params.get('x'));
        const pxY = Number(params.get('y'));
        if ([tlX, tlY, pxX, pxY].every(n => Number.isFinite(n))) {
          window.dispatchEvent(new CustomEvent(EVENT_NAME, {
            detail: { tlX, tlY, pxX, pxY, source: 'fetch-hook', ts: Date.now() }
          }));
        }
      }
    } catch (err) {
      console.warn('[WPI_MAIN] fetch tap error', err);
    }
    return response;
  };
})();
