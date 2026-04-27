import { pipeline, env } from '@huggingface/transformers';
import { MODEL_ID, EMBEDDING_DIMS } from './constants.js';

// Point ONNX Runtime at the WASM files shipped with the extension
// (copied to dist/wasm/ by build.mjs). CSP blocks CDN WASM.
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('wasm/');

// Let the model download from Hugging Face on first run, then live in the
// browser Cache API on subsequent runs. CSP allows huggingface.co + CDNs.
env.allowLocalModels = false;
env.useBrowserCache = true;
env.remoteHost = 'https://huggingface.co/';

// Instrument fetch so a CSP-blocked or network-failed model download is
// diagnosable from the offscreen console instead of a generic "Failed to fetch".
const origFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  try {
    const res = await origFetch(input, init);
    if (!res.ok) console.warn(`[embed fetch] ${res.status} ${url}`);
    return res;
  } catch (err) {
    console.error(`[embed fetch] FAILED ${url}`, err);
    throw new Error(`fetch failed for ${url}: ${err.message}`);
  }
};

let pipelinePromise = null;
let coldStartMs = null;
let firstEmbedReported = false;

// Singleton loader — guards against concurrent callers racing on a cold start.
function getPipeline() {
  if (!pipelinePromise) {
    const t0 = performance.now();
    pipelinePromise = pipeline('feature-extraction', MODEL_ID, {
      dtype: 'q8',
    }).then((p) => {
      coldStartMs = performance.now() - t0;
      console.log(`[embed] pipeline ready in ${coldStartMs.toFixed(0)}ms`);
      return p;
    });
  }
  return pipelinePromise;
}

export async function embed(text) {
  const p = await getPipeline();
  const t0 = performance.now();
  const output = await p(text, { pooling: 'mean', normalize: true });
  const embedMs = performance.now() - t0;

  if (output.data.length !== EMBEDDING_DIMS) {
    throw new Error(
      `unexpected embedding dims: got ${output.data.length}, expected ${EMBEDDING_DIMS}`,
    );
  }

  // Report cold-start once, on the first successful embed.
  const reportColdStart = !firstEmbedReported ? coldStartMs : 0;
  firstEmbedReported = true;

  return {
    vector: output.data, // Float32Array(384)
    dims: output.data.length,
    coldStartMs: reportColdStart,
    embedMs,
  };
}
