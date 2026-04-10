/* ═══════════════════════════════════════════════════════════════
   Kenoki — Embedding Web Worker
   Runs transformers.js off the main thread (never blocks UI).
   Model: Xenova/all-MiniLM-L6-v2 — 23MB, 384 dims, MIT license.
   Cached by browser after first load — subsequent loads are instant.
   Cost: $0. Runs locally in the browser.
   ═══════════════════════════════════════════════════════════════ */

// Use the @xenova/transformers UMD build via importScripts (Worker-compatible)
importScripts('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js');

let extractor = null;

async function getExtractor() {
  if (!extractor) {
    // pipeline() from the Transformers global loaded via importScripts
    extractor = await Transformers.pipeline(
      'feature-extraction',
      'Xenova/all-MiniLM-L6-v2',
      { quantized: true } // smaller, faster — quality negligible difference for this task
    );
  }
  return extractor;
}

self.onmessage = async ({ data: { id, text } }) => {
  try {
    const ext = await getExtractor();
    const output = await ext(text, { pooling: 'mean', normalize: true });
    // output.data is a Float32Array — convert to plain Array for postMessage
    self.postMessage({ id, embedding: Array.from(output.data) });
  } catch (err) {
    self.postMessage({ id, error: err.message });
  }
};
