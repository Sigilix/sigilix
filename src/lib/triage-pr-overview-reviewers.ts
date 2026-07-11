/** Remove the PR author from model-suggested reviewers without changing the
 * ordering of the remaining candidates. */
export function excludePrAuthor(
  reviewers: readonly string[] | undefined,
  prAuthor: string | null,
): string[] | undefined {
  if (!reviewers || reviewers.length === 0 || !prAuthor) return reviewers ? [...reviewers] : undefined
  const author = prAuthor.toLowerCase()
  const filtered = reviewers.filter((reviewer) => reviewer.trim().replace(/^@/u, "").toLowerCase() !== author)
  return filtered.length > 0 ? filtered : undefined
}
