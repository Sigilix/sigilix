// Exact session-to-installation authorization for tenant-scoped product data.
// A request-selected installation is never trusted directly: this adapter
// confirms it against the authenticated user's fresh GitHub App installation
// listing, with one shared timeout and a hard pagination bound.

const MAX_PAGES = 20
const PER_PAGE = 100
const DEFAULT_TIMEOUT_MS = 5_000
const MAX_RESPONSE_BYTES = 1_000_000

interface InstallationsResponse {
  installations?: Array<{ id?: number }>
}

export type UserInstallationAccessResult =
  | { ok: true }
  | { ok: false; reason: "not_owned" | "lookup_failed" | "timeout" }

function githubHeaders(accessToken: string): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${accessToken}`,
    "user-agent": "sigilix-worker",
  }
}

/**
 * Confirm that one positive installation id is present in the current user's
 * GitHub App installation listing. Page shape is authoritative: an empty
 * sentinel page proves a full 20-page result complete, while a non-empty page
 * beyond the cap fails closed as unconfirmable.
 */
export async function userCanAccessInstallation(
  accessToken: string,
  installationId: number,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<UserInstallationAccessResult> {
  if (!accessToken || !Number.isSafeInteger(installationId) || installationId <= 0) {
    return { ok: false, reason: "lookup_failed" }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS))
  try {
    for (let page = 1; page <= MAX_PAGES + 1; page++) {
      const fetchOperation = (options.fetchImpl ?? fetch)(
        `https://api.github.com/user/installations?per_page=${PER_PAGE}&page=${page}`,
        { headers: githubHeaders(accessToken), signal: controller.signal },
      )
      void fetchOperation.then(
        (lateResponse) => {
          if (controller.signal.aborted) void lateResponse.body?.cancel().catch(() => undefined)
        },
        () => undefined,
      )
      const response = await raceAbort(fetchOperation, controller.signal)
      if (!response.ok) return { ok: false, reason: "lookup_failed" }
      const body = (await readJsonCapped(response, controller.signal)) as InstallationsResponse
      if (!Array.isArray(body.installations)) return { ok: false, reason: "lookup_failed" }
      if (page > MAX_PAGES) {
        return body.installations.length === 0
          ? { ok: false, reason: "not_owned" }
          : { ok: false, reason: "lookup_failed" }
      }
      if (body.installations.some((installation) => installation.id === installationId)) return { ok: true }
      if (body.installations.length < PER_PAGE) return { ok: false, reason: "not_owned" }
    }
    return { ok: false, reason: "lookup_failed" }
  } catch {
    return { ok: false, reason: controller.signal.aborted ? "timeout" : "lookup_failed" }
  } finally {
    clearTimeout(timer)
  }
}

async function readJsonCapped(response: Response, signal: AbortSignal): Promise<unknown> {
  const declared = response.headers.get("content-length")
  if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) throw new Error("github_response_too_large")
  const reader = response.body?.getReader()
  if (!reader) throw new Error("github_empty_response")
  const chunks: Uint8Array[] = []
  let total = 0
  let complete = false
  try {
    for (;;) {
      const { done, value } = await raceAbort(reader.read(), signal)
      if (done) {
        complete = true
        break
      }
      if (!value) continue
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw new Error("github_response_too_large")
      chunks.push(value)
    }
  } finally {
    if (!complete) void reader.cancel().catch(() => undefined)
    try {
      reader.releaseLock()
    } catch {
      // A timed-out read may still hold the lock until cancellation settles.
    }
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(merged)
  return JSON.parse(text) as unknown
}

function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort)
    const abort = () => {
      cleanup()
      reject(Object.assign(new Error("GitHub installation lookup timed out"), { name: "AbortError" }))
    }
    void operation.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      },
    )
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
  })
}
