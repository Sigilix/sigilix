// Org-teach authorization for the Linear mention-reply surface.
//
// An ORG-scope learning shapes every teammate's PR reviews, so only a Linear
// workspace admin may write one (mirrors the GitHub path's hasRepoWriteAccess
// gate). This is the small, fail-closed helper the capture site in
// mention-reply.ts wraps its captureInstructiveLearning call with.

/**
 * Result of the org-teach authorization check: whether the commenter may write
 * an ORG-scope learning, plus a stable `reason` so an over-denial ("couldn't
 * determine") is distinguishable in the logs from a correct denial ("not-admin").
 */
export interface OrgTeachAuthz {
  authorized: boolean
  reason: string
}

/**
 * FAIL-CLOSED workspace-admin check for the Linear surface. `admin` is fetched
 * on the comment author by `getCommentWithIssue`. `admin === true` → authorized;
 * `false` → "not-admin"; missing/undefined/null (older query, a guest, or a
 * field the token can't read) → "unknown" and NOT authorized — a failure can
 * only REDUCE capture.
 */
export function isLinearOrgTeacher(user: { admin?: boolean | null } | null | undefined): OrgTeachAuthz {
  if (!user || user.admin === undefined || user.admin === null) {
    return { authorized: false, reason: "unknown" }
  }
  return user.admin === true ? { authorized: true, reason: "admin" } : { authorized: false, reason: "not-admin" }
}
