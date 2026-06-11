// SIG-395 — the invariant-lens auditor prompts (single source: the engine
// phase AND the e2e harness import from here, so the fixture eval always
// measures the shipped prompts).
//
// Design, measured before shipping (PR #479, two K=8 iterations): ONE
// whole-diff "find inconsistencies" call re-saturates exactly like a
// regular review pass — the model gravitates to the loudest bugs. Six
// SINGLE-CHARGE auditors, each deriving and sweeping exactly one invariant
// family, crack the cross-cutting tail instead (b19 0/8→8/8, b4 0/8→7/8).
// The deterministic-floor lesson applied to prompts: one narrow question
// swept exhaustively beats one broad mandate.
//
// Families are GENERIC (taxonomy-derived, never fixture-coached) — the
// lens must generalize or it is overfit theater.

import { SHARED_NEGATIVE_CONSTRAINTS, SHARED_OUTPUT_INSTRUCTIONS } from "./shared"

export interface InvariantFamily {
  id: string
  charge: string
}

export const INVARIANT_FAMILIES: readonly InvariantFamily[] = [
  {
    id: "units",
    charge:
      "UNITS & REPRESENTATION: a single canonical unit/representation per quantity (e.g. integer minor units for money, one timestamp format, one ID shape). Find every producer/consumer in the diff that disagrees with the convention the diff itself establishes.",
  },
  {
    id: "data-scoping",
    charge:
      "DATA SCOPING: when any endpoint restricts data access by an ownership key (tenant/customer/user scoping in its query or handler), EVERY sibling endpoint touching the same data class must scope the same way. Enumerate every data-touching endpoint in the diff and check each one against the scoping rule the most-careful sibling establishes.",
  },
  {
    id: "discriminant-totality",
    charge:
      "DISCRIMINANT TOTALITY: for every discriminated union / enum / event-type field declared in the diff, every consumer must handle or explicitly reject each arm. List the arms, list the consumers, and flag any consumer that silently treats all arms the same.",
  },
  {
    id: "error-contracts",
    charge:
      "ERROR CONTRACTS: sibling handlers establish status/shape conventions for not-found / invalid-input / failure paths. Enumerate each handler's failure paths and flag any that return the success shape or status on a failure path the siblings handle properly.",
  },
  {
    id: "crypto-integrity",
    charge:
      "CRYPTO/INTEGRITY DISCIPLINE: signatures/HMACs must be computed over exactly the bytes received (never a re-serialization); secrets must fail closed when unconfigured; comparisons must be constant-time. Check every signature/secret/comparison site in the diff against these.",
  },
  {
    id: "wire-contracts",
    charge:
      "WIRE/TYPE CONTRACTS: declared types/interfaces/casing versus what the code actually returns, casts, or serializes. Flag every raw cast or response that bypasses the declared shape (a cast that silences the type system is a violation site, not a style choice).",
  },
]

export function buildInvariantFamilyPrompt(family: InvariantFamily): string {
  return `${SHARED_NEGATIVE_CONSTRAINTS}

You are a CONSISTENCY AUDITOR with exactly ONE charge in this review. Other reviewers cover everything else; you must NOT report anything outside your charge.

YOUR CHARGE — ${family.charge}

Method: derive the concrete rule(s) of your charge from THIS diff (the diff's own types, contracts, and most-careful sibling code define the convention), then sweep EVERY changed file for violations of those rules — especially sites that look locally fine and are only wrong relative to the rule established elsewhere. Quote both sides in each finding: the rule-establishing site and the violating site. Report ONLY grounded violations of your charge; if the diff establishes no such rule and contains no violation, return zero findings — an empty result is a correct result.

${SHARED_OUTPUT_INSTRUCTIONS}`
}
