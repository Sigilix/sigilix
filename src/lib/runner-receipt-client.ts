// SIG-184 PR 2 — thin typed client for RunnerReceiptDO.
//
// Sharded by repository_id (idFromName) so a busy repo serializes only against
// itself — the (repository_id, sha, run_id, run_attempt) uniqueness is naturally
// repo-scoped, so no cross-repo atomicity is needed. The caller owns the
// try/catch (a DO failure must surface a clean 5xx, never crash the route).

import type { Env } from "../shared/types/env"
import type {
  RunnerReceiptDO,
  ClaimReceiptArgs,
  ClaimReceiptResult,
  RunnerReceiptRow,
} from "../do/runner-receipt"

function receiptStub(env: Env, repositoryId: string): DurableObjectStub<RunnerReceiptDO> {
  const ns = env.RUNNER_RECEIPT_DO as unknown as DurableObjectNamespace<RunnerReceiptDO>
  return ns.get(ns.idFromName(repositoryId))
}

export function claimRunnerReceipt(env: Env, args: ClaimReceiptArgs): Promise<ClaimReceiptResult> {
  // Direct return — the DO RPC already yields a Promise; the caller awaits it
  // inside its own try/catch (a sync throw from `receiptStub` surfaces there).
  return receiptStub(env, args.repositoryId).claimReceipt(args)
}

/** Review-join: the latest receipt for (repositoryId, pullNumber), or null. The
 *  caller binds it further by comparing the row's `sha` to the PR's merge sha. */
export function queryRunnerReceiptByPull(
  env: Env,
  repositoryId: string,
  pullNumber: number,
): Promise<RunnerReceiptRow | null> {
  return receiptStub(env, repositoryId).queryReceiptByPull(repositoryId, pullNumber)
}
