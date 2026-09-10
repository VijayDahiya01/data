/**
 * Byte helpers.
 *
 * Prisma 7 types `Bytes` columns as `Uint8Array<ArrayBuffer>`. Node's Buffer is
 * `Buffer<ArrayBufferLike>` and is therefore not assignable, because
 * ArrayBufferLike admits SharedArrayBuffer. Copying into a fresh Uint8Array
 * both satisfies the type and detaches from any pooled Buffer -- Node reuses
 * an internal pool for small allocations, so retaining a Buffer slice can keep
 * unrelated bytes alive.
 */
export function toBytes(buf: Buffer | Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(buf.byteLength);
  out.set(buf);
  return out;
}
