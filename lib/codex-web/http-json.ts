/** Bound bytes while reading control-plane JSON, before buffering the entire response. */
export async function readBoundedJson(response: Response, maxBytes: number, label: string): Promise<unknown> {
  const oversized = () => new Error(`${label} exceeds its size budget`);
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await response.body?.cancel();
    throw oversized();
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${label} has no JSON body`);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw oversized();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
}
