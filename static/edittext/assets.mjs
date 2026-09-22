// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 BTLTECH LTD
//
// The one place the edit-text engine touches the outside world.
//
// The same engine source runs in two places: in the customer's browser, where it
// fetches its WASM and fonts over HTTP, and in the regression harness under Node,
// where it reads them from disk. Keeping that difference here - and nowhere else -
// is what lets the regression suite test the code that actually ships rather than a
// near-copy of it.
//
// Fonts are read synchronously deep inside the engine, and a browser cannot fetch
// synchronously, so a font must be pulled into the cache with `ensureFonts()`
// before an edit is planned. `fontBytes()` then serves it from memory.

const isNode = typeof process !== "undefined" && !!process.versions?.node;

// Where the assets live. In the browser these are URLs under /static; under Node
// they are paths relative to this file, which sits in the same static directory.
const BASE = {
  pdfiumWasm: "../vendor/pdfium/pdfium.wasm",
  harfbuzzWasm: "../vendor/harfbuzz/harfbuzz-subset.wasm",
  fonts: "../fonts/",
};

let nodeFs = null, nodePath = null;
async function node() {
  if (!nodeFs) { nodeFs = await import("node:fs"); nodePath = await import("node:path"); }
  return { fs: nodeFs, path: nodePath };
}
const here = () => new URL(".", import.meta.url);

export async function assetBytes(rel) {
  if (isNode) {
    const { fs } = await node();
    return new Uint8Array(fs.readFileSync(new URL(rel, import.meta.url)));
  }
  const res = await fetch(new URL(rel, import.meta.url));
  if (!res.ok) throw new Error(`cannot load ${rel}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export const pdfiumWasm = () => assetBytes(BASE.pdfiumWasm);
export const harfbuzzWasm = () => assetBytes(BASE.harfbuzzWasm);

// ------------------------------------------------------------- font cache ---
const cache = new Map();

/** Pull font files into memory so the engine's synchronous paths can read them. */
export async function ensureFonts(files) {
  await Promise.all([...new Set(files)].filter((f) => f && !cache.has(f)).map(async (f) => {
    try { cache.set(f, await assetBytes(BASE.fonts + f)); }
    catch { cache.set(f, null); }              // recorded as unavailable, not retried
  }));
}

export function fontBytes(file) {
  if (cache.has(file)) {
    const b = cache.get(file);
    if (b) return b;
    throw new Error(`font ${file} could not be loaded`);
  }
  if (isNode) {                                // the harness may read one directly
    const b = new Uint8Array(nodeFs.readFileSync(new URL(BASE.fonts + file, import.meta.url)));
    cache.set(file, b);
    return b;
  }
  throw new Error(`font ${file} was not preloaded - call ensureFonts() first`);
}

// Node needs fs loaded before any synchronous fontBytes() call can work.
if (isNode) await node();

// ------------------------------------------------------------ file access ---
// Only the Node harness reads and writes PDFs by path; in the browser the bytes
// come from the customer's file picker and never touch a filesystem or a network.
export function readFileSync(path) {
  if (!isNode) throw new Error("reading by path is not available in the browser");
  return new Uint8Array(nodeFs.readFileSync(path));
}
export function writeFileSync(path, bytes) {
  if (!isNode) throw new Error("writing by path is not available in the browser");
  nodeFs.writeFileSync(path, bytes);
}
export { isNode };
