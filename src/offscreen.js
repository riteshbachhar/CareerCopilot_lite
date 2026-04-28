import { embed } from './embed.js';
import { MODEL_ID, MODEL_VERSION } from './constants.js';
import * as pdfjsLib from 'pdfjs-dist';

const BOOTED_AT = Date.now();

// pdf.js spawns a Worker(workerSrc) on the first getDocument() call. Point it
// at the local copy that build.mjs lays into dist/. (CDN URLs would be blocked
// by our connect-src CSP, and we don't want the network dependency anyway.)
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.mjs');

// Decode a base64 string into a Uint8Array. We send PDFs from the side panel
// as base64 because typed arrays don't reliably survive chrome.runtime
// messaging — same workaround as the Float32Array→Array conversion below.
function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function parsePdfBytes(bytes) {
  const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
  const pageTexts = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    pageTexts.push(tc.items.map((it) => ('str' in it ? it.str : '')).join(' '));
  }
  return { text: pageTexts.join('\n\n'), pages: doc.numPages };
}

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

  if (msg.type === 'parse-pdf') {
    (async () => {
      try {
        if (typeof msg.base64 !== 'string' || !msg.base64.length) {
          throw new Error('parse-pdf: missing base64 payload');
        }
        const bytes = base64ToBytes(msg.base64);
        const t0 = performance.now();
        const { text, pages } = await parsePdfBytes(bytes);
        sendResponse({
          ok: true,
          text,
          pages,
          parseMs: Math.round(performance.now() - t0),
        });
      } catch (err) {
        console.error('[offscreen] parse-pdf failed', err);
        sendResponse({ ok: false, error: String(err?.message ?? err) });
      }
    })();
    return true;
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
