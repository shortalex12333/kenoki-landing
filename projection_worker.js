/* ═══════════════════════════════════════════════════════════════
   Kenoki — Projection Worker
   Computes 384-dim embeddings for people in the background.
   Triggered automatically after every import and on first load.
   Model: Xenova/all-MiniLM-L6-v2 — 23MB, MIT licence, runs locally.
   Cost: $0. No API key. No server.
   ═══════════════════════════════════════════════════════════════ */

importScripts('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js');

let extractor = null;

async function getExtractor() {
  if (!extractor) {
    extractor = await Transformers.pipeline(
      'feature-extraction',
      'Xenova/all-MiniLM-L6-v2',
      { quantized: true }
    );
  }
  return extractor;
}

self.onmessage = async ({ data: { id, text } }) => {
  try {
    const ext = await getExtractor();
    const output = await ext(text, { pooling: 'mean', normalize: true });
    self.postMessage({ id, embedding: Array.from(output.data) });
  } catch (err) {
    self.postMessage({ id, error: err.message });
  }
};
