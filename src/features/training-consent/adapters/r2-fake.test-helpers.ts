// sig-training-data-consent — in-memory R2 stub for tests (put / list(prefix) /
// delete(keys)). In its own .test-helpers.ts so importing it from multiple specs
// does not re-register any describe blocks.

/** Minimal in-memory R2 bucket + a peek at its backing store. */
export function makeR2(): { bucket: R2Bucket; store: Map<string, string> } {
  const store = new Map<string, string>()
  const bucket = {
    put: async (key: string, value: unknown) => {
      store.set(key, typeof value === "string" ? value : String(value))
      return {}
    },
    delete: async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k)
    },
    list: async (opts?: { prefix?: string }) => {
      const prefix = opts?.prefix ?? ""
      const objects = [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key }))
      return { objects, truncated: false, delimitedPrefixes: [] }
    },
  } as unknown as R2Bucket
  return { bucket, store }
}
