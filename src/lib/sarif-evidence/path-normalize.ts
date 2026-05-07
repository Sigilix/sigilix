// ARC-188: SARIF path normalizer.
//
// SARIF producers emit paths in many shapes:
//   - bare relative: `src/foo.ts`
//   - URI-encoded: `src%2Ffoo.ts`
//   - leading-dot: `./src/foo.ts`
//   - file://-scheme: `file:///path/to/foo.ts`
//   - host-absolute: `/etc/passwd`
//   - Windows backslash: `src\foo.ts`
//   - Windows-absolute: `C:\path\foo.ts`
//   - UNC: `\\server\share\foo.ts`
//   - traversal: `../etc/passwd`
//   - encoded-traversal: `%2e%2e/etc/passwd`, `src/%2e%2e/foo`
//   - `artifactLocation.index` instead of inline `uri`
//   - `uriBaseId` symbolic prefix (`%SRCROOT%` etc.)
//
// v1 normalizes the safe ones to repo-relative slash-separated form
// and rejects everything else with a structured reason. Decode
// happens BEFORE traversal-check so encoded `%2e%2e/` doesn't slip
// past (Codex MAJOR #4).
//
// Spec §4.4. Codex BLOCKING #2 on plan v1: artifacts shape is
// `Array<{ location?: { uri?: string } }>`, not `Array<{ uri?: string }>`.

export interface NormalizeArgs {
  uriBaseId?: string
  /** SARIF run-level artifacts table. `index` looks up against this. */
  artifacts?: Array<{ location?: { uri?: string } }>
  /** When `rawUri` is undefined and `index` is set, resolve via
   *  `artifacts[index].location.uri`. */
  index?: number
}

export type NormalizeOk = { ok: true; path: string }
export type NormalizeErr = { ok: false; reason: string }
export type NormalizeResult = NormalizeOk | NormalizeErr

const SUPPORTED_BASE_IDS: ReadonlySet<string> = new Set(["%SRCROOT%"])

function decodeOnce(raw: string): string | null {
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

/**
 * Normalize a SARIF path. Returns `{ ok: true, path }` for safe
 * repo-relative paths or `{ ok: false, reason }` for any rejected
 * shape. Never throws.
 */
export function normalizeSarifPath(
  rawUri: string | undefined,
  opts: NormalizeArgs = {},
): NormalizeResult {
  // 1. `index` resolution (Kimi MAJOR #2 negative paths)
  let uri: string | undefined = rawUri
  if (uri === undefined || uri === "") {
    if (typeof opts.index === "number") {
      if (!Array.isArray(opts.artifacts)) {
        return { ok: false, reason: "index set but artifacts array missing" }
      }
      if (opts.index < 0 || opts.index >= opts.artifacts.length) {
        return { ok: false, reason: `index ${opts.index} out of bounds (artifacts length ${opts.artifacts.length})` }
      }
      const lookedUp = opts.artifacts[opts.index]?.location?.uri
      if (typeof lookedUp !== "string" || lookedUp.length === 0) {
        return { ok: false, reason: `artifacts[${opts.index}].location.uri is undefined` }
      }
      uri = lookedUp
    } else {
      return { ok: false, reason: "no path or index" }
    }
  }

  // 2. uriBaseId — only `%SRCROOT%` is honored. Other base IDs
  //    reference scanner-host paths we can't safely resolve.
  if (opts.uriBaseId !== undefined && !SUPPORTED_BASE_IDS.has(opts.uriBaseId)) {
    return { ok: false, reason: `unsupported uriBaseId: ${opts.uriBaseId}` }
  }

  // 3. URI decode — DECODE FIRST so encoded traversal is caught by
  //    the traversal check below. Reject malformed encoding.
  const decoded = decodeOnce(uri)
  if (decoded === null) {
    return { ok: false, reason: `malformed percent encoding in path: ${uri}` }
  }
  uri = decoded

  // 4. Strip `file://` scheme. Anything else with a scheme is
  //    rejected (e.g. `http://`, `https://` would be remote files
  //    we can't read).
  if (uri.startsWith("file://")) {
    uri = uri.slice("file://".length)
    // After the scheme strip, file:// URIs commonly land as
    // `/path/to/foo.ts` (host-absolute on Unix) or
    // `/C:/path/foo.ts` (Windows). The host-absolute reject below
    // catches Unix; we also explicitly catch the Windows form here.
    if (/^\/[A-Za-z]:[\\/]/.test(uri)) {
      return { ok: false, reason: "absolute Windows path under file://" }
    }
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(uri)) {
    return { ok: false, reason: `unsupported URI scheme: ${uri}` }
  }

  // 5. Windows path detection BEFORE separator normalization. Both
  //    drive-letter (`C:\path`) and UNC (`\\server\share`) point at
  //    the scanner host filesystem, not the repo.
  if (/^[A-Za-z]:[\\/]/.test(uri)) {
    return { ok: false, reason: "absolute Windows path" }
  }
  if (uri.startsWith("\\\\")) {
    return { ok: false, reason: "UNC path" }
  }

  // 6. Normalize backslashes to forward slashes (Windows-relative
  //    `src\foo.ts` → `src/foo.ts`).
  uri = uri.replace(/\\/g, "/")

  // 7. Strip leading `./`. Repeated leading `./` segments collapse.
  while (uri.startsWith("./")) {
    uri = uri.slice(2)
  }

  // 8. Reject host-absolute paths.
  if (uri.startsWith("/")) {
    return { ok: false, reason: "host-absolute path rejected" }
  }

  // 9. Reject any `..` segment AFTER decode + normalize. Catches
  //    `../etc/passwd`, `src/../foo`, `%2e%2e/etc/passwd`, etc.
  const segments = uri.split("/")
  for (const seg of segments) {
    if (seg === "..") {
      return { ok: false, reason: "path traversal rejected" }
    }
  }

  // 10. Empty after normalization (e.g. just `./`).
  if (uri.length === 0) {
    return { ok: false, reason: "empty path after normalization" }
  }

  return { ok: true, path: uri }
}
