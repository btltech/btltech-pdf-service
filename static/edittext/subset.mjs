// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 BTLTECH LTD
// Font subsetting with HarfBuzz (harfbuzzjs, MIT; HarfBuzz itself is MIT).
// Embedding a whole open font added 0.2-1.2 MB to an edited PDF. A subset keeps
// only the characters the new text uses, with the character map intact so the
// PDF engine can still look glyphs up by character.
import { harfbuzzWasm } from "./assets.mjs";

const { instance } = await WebAssembly.instantiate(await harfbuzzWasm(), {});
const hb = instance.exports;
const HB = new Uint8Array(hb.memory.buffer);
const view = () => new DataView(hb.memory.buffer);

export function subsetFont(bytes, text) {
  const dataPtr = hb.malloc(bytes.length);
  new Uint8Array(hb.memory.buffer).set(bytes, dataPtr);
  const blob = hb.hb_blob_create(dataPtr, bytes.length, 2 /* writable */, 0, 0);
  const face = hb.hb_face_create(blob, 0);
  const input = hb.hb_subset_input_create_or_fail();
  if (!input) throw new Error("harfbuzz: could not create a subset input");
  const unicodes = hb.hb_subset_input_unicode_set(input);
  for (const ch of new Set([...text, " "])) hb.hb_set_add(unicodes, ch.codePointAt(0));
  // keep the font's own layout tables minimal but retain a usable cmap
  const subsetFace = hb.hb_subset_or_fail(face, input);
  if (!subsetFace) { hb.hb_subset_input_destroy(input); hb.hb_face_destroy(face); hb.hb_blob_destroy(blob); throw new Error("harfbuzz: subsetting failed"); }
  const outBlob = hb.hb_face_reference_blob(subsetFace);
  const lenPtr = hb.malloc(4);
  const ptr = hb.hb_blob_get_data(outBlob, lenPtr);
  const len = view().getUint32(lenPtr, true);
  const out = new Uint8Array(hb.memory.buffer).slice(ptr, ptr + len);
  hb.free(lenPtr); hb.hb_blob_destroy(outBlob); hb.hb_face_destroy(subsetFace);
  hb.hb_subset_input_destroy(input); hb.hb_face_destroy(face); hb.hb_blob_destroy(blob); hb.free(dataPtr);
  return out;
}
