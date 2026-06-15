// SIG-418 Phase 2 (Design B′) — in-invocation multi-batch review: pure finding-id
// namespacing (domain layer).
//
// When the PR is reviewed in multiple batches, each batch's specialist mints its
// own `${role}-${i}` ids (`assignStableFindingIds`, `findings.ts`). Across
// batches those COLLIDE — every batch's logic specialist emits `logic-0`,
// `logic-1`, … so a merged review can't tell two batches' `logic-0` apart, and
// the dedup passes would falsely treat them as the same finding. Namespacing the
// id per batch fixes that.
//
// CRITICAL (mandatory correction #2 from the spec's DECISION block): the
// namespace must be **role-FIRST** — `${role}-b${batchIdx}-${idx}` (e.g.
// `logic-b1-0`), NOT `b1:logic-0` or `b1-logic-0`. The validation layer infers a
// finding's role from the id PREFIX via `id.startsWith(\`${role}-\`)`
// (`firstSpecialistRoleFromSourceIds` / `sourceRolesInclude`,
// `validation-args.ts`; plus the other role-from-id readers). A batch-first
// prefix (`b1-…`) would make every role gate read the role as `"b1"` and no-op —
// silently skipping the security/logic/perf evidence + refute validators. Keeping
// the role first means `logic-b1-0`.startsWith("logic-") is still true, so role
// inference is unchanged and ids are unique across batches.
//
// PR 1 is DARK: these are pure helpers only. The mint site
// (`assignStableFindingIds`) is NOT changed here — wiring the batch loop to use
// this namespace is PR 2. So default behavior is byte-identical.

import { ALL_SPECIALISTS, type SpecialistRole } from "@/src/shared/domain/specialist-role"

/**
 * Namespace a per-batch finding id as `${role}-b${batchIdx}-${idx}` — role FIRST
 * so the existing prefix-based role inference still resolves the role. PURE.
 *
 * @param role     the minting specialist's role (`logic` | `security` | …)
 * @param batchIdx the 0-based batch index within the review
 * @param idx      the 0-based finding index within that batch's verdict
 */
export function namespaceFindingId(role: SpecialistRole, batchIdx: number, idx: number): string {
  return `${role}-b${batchIdx}-${idx}`
}

/** The components recovered from a namespaced finding id. */
export interface ParsedNamespacedFindingId {
  role: SpecialistRole
  batchIdx: number
  index: number
}

// `${role}-b${batchIdx}-${index}` where role ∈ ALL_SPECIALISTS. Role is matched
// from the canonical set (not a greedy `[a-z]+`) so this can never accept a
// non-role prefix; the batch + finding indices are non-negative integers.
const NAMESPACED_ID_RE = new RegExp(`^(${ALL_SPECIALISTS.join("|")})-b(\\d+)-(\\d+)$`)

/**
 * Inverse of `namespaceFindingId`: extract the role + batch index (+ in-batch
 * finding index) from a namespaced id. Returns `null` for any id that is not in
 * the `${role}-b${n}-${i}` shape (e.g. the un-prefixed `${role}-${i}` mint, or a
 * deterministic-evidence id like `ast/…` / `secret:…`). PURE.
 */
export function parseNamespacedFindingId(id: string): ParsedNamespacedFindingId | null {
  const m = NAMESPACED_ID_RE.exec(id)
  if (!m) return null
  return {
    role: m[1] as SpecialistRole,
    batchIdx: Number.parseInt(m[2]!, 10),
    index: Number.parseInt(m[3]!, 10),
  }
}
