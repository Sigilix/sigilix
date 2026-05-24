export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  if (items.length === 0) return []

  const workerCount = Math.max(1, Math.min(items.length, Math.floor(concurrency)))
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
