import { embed } from './embed.js';
import { MODEL_ID, MODEL_VERSION } from './constants.js';

const BOOTED_AT = Date.now();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;

  if (msg.type === 'ping') {
    sendResponse({
      type: 'pong',
      origin: 'offscreen',
      receivedAt: Date.now(),
      sentAt: msg.payload?.sentAt ?? null,
      bootedAt: BOOTED_AT,
      ageMs: Date.now() - BOOTED_AT,
      userAgent: navigator.userAgent.slice(0, 80),
    });
    return false;
  }

  if (msg.type === 'embed') {
    (async () => {
      try {
        const { vector, dims, coldStartMs, embedMs } = await embed(msg.text);
        // Float32Array doesn't survive structured clone as a typed array through
        // chrome.runtime messaging in all contexts — send as a plain number array.
        sendResponse({
          ok: true,
          vector: Array.from(vector),
          dims,
          modelId: MODEL_ID,
          modelVersion: MODEL_VERSION,
          coldStartMs,
          embedMs,
        });
      } catch (err) {
        console.error('[offscreen] embed failed', err);
        sendResponse({ ok: false, error: String(err?.message ?? err) });
      }
    })();
    return true; // async response
  }

  return false;
});
