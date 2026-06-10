// SIG-318 / SIG-387: UTF-8-safe base64 decode, extracted from client.ts so the
// module-level helper lives in its own leaf. client.ts imports it.

/**
 * UTF-8-safe atob. The plain `atob` returns a binary string; if the file
 * has multi-byte chars, naive String.fromCharCode loses bytes. Decode via
 * Uint8Array + TextDecoder so the model sees the source verbatim.
 */
export function atobUtf8(b64: string): string {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder("utf-8").decode(bytes)
}
