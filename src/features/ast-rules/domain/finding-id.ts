// ARC-181: stable `astFindingId` for synth supersession + audit
// markers. Format: `ast/<ruleId>/<pathHash7>/<line>`. The pathHash7
// is the first 7 hex chars of SHA-256 over the file path so paths
// with the same basename in different directories don't collide on
// the visible portion of the marker.

const PATH_HASH_PREFIX_BYTES = 7

function toHex(bytes: Uint8Array): string {
  let out = ""
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0
    out += b.toString(16).padStart(2, "0")
  }
  return out
}

export async function pathHash7(path: string): Promise<string> {
  const enc = new TextEncoder().encode(path)
  const buf = await crypto.subtle.digest("SHA-256", enc)
  return toHex(new Uint8Array(buf)).slice(0, PATH_HASH_PREFIX_BYTES)
}

export async function astFindingId(ruleId: string, path: string, line: number): Promise<string> {
  const h = await pathHash7(path)
  return `ast/${ruleId}/${h}/${line}`
}
