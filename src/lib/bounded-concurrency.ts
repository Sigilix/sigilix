export function normalizeConcurrencyLimit(
  concurrency: number | undefined,
  maxConcurrency: number,
  fallback = 1,
): number {
  const max = Math.max(1, Math.floor(maxConcurrency))
  const fallbackValue = Number.isFinite(fallback) ? Math.max(1, Math.floor(fallback)) : 1
  const candidate = Number(concurrency ?? fallbackValue)
  const value = Number.isFinite(candidate) ? Math.floor(candidate) : fallbackValue
  return Math.max(1, Math.min(max, value))
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  if (items.length === 0) return []

  const workerCount = normalizeConcurrencyLimit(concurrency, items.length)
  const results = new Array<PromiseSettledResult<R>>(items.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++
      if (index >= items.length) return
      try {
        results[index] = {
          status: "fulfilled",
          value: await mapper(items[index]!, index),
        }
      } catch (reason) {
        results[index] = { status: "rejected", reason }
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}
