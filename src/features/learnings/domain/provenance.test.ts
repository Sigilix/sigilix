import { describe, expect, it } from "vitest"

import {
  buildMemoryProvenance,
  renderMemoryProvenance,
  resolveAppliedMemoryProvenance,
} from "@/src/features/learnings/domain/provenance"
import { resolveMemoryProvenanceMode } from "@/src/features/learnings/domain/mode"
import type { LearningEntry } from "@/src/features/learnings/domain/types"
import type { Env } from "@/src/shared/types/env"

const TS = "2026-06-15T12:00:00.000Z"

function entry(over: Partial<LearningEntry> = {}): LearningEntry {
  return {
    id: over.id ?? "l1",
    rule: over.rule ?? "Prefer service-layer database access.",
    polarity: over.polarity ?? "context",
    category: over.category ?? null,
    pathGlob: over.pathGlob ?? null,
    scope: over.scope ?? "repo",
    subjectId: over.subjectId ?? "123",
    source: over.source ?? { kind: "command", prNumber: 7 },
    createdTs: over.createdTs ?? TS,
    appliedCount: over.appliedCount ?? 0,
  }
}

describe("resolveMemoryProvenanceMode", () => {
  it("defaults OFF for unset / any other value, ON only for exactly 'on'", () => {
    expect(resolveMemoryProvenanceMode({} as Env)).toBe("off")
    expect(resolveMemoryProvenanceMode({ OPENCLAW_MEMORY_PROVENANCE: "shadow" } as Env)).toBe("off")
    expect(resolveMemoryProvenanceMode({ OPENCLAW_MEMORY_PROVENANCE: "true" } as Env)).toBe("off")
    expect(resolveMemoryProvenanceMode({ OPENCLAW_MEMORY_PROVENANCE: "on" } as Env)).toBe("on")
    expect(resolveMemoryProvenanceMode({ OPENCLAW_MEMORY_PROVENANCE: "  ON  " } as Env)).toBe("on")
  })
})

describe("buildMemoryProvenance", () => {
  it("returns null for an empty applied set", () => {
    expect(buildMemoryProvenance([])).toBeNull()
  })

  it("captures id, label, scope, and pathGlob for non-suppress entries", () => {
    const prov = buildMemoryProvenance([
      entry({ id: "org-1", scope: "org", polarity: "require", rule: "No raw SQL in handlers." }),
      entry({ id: "repo-1", scope: "repo", rule: "Entry point is src/index.ts.", pathGlob: "src/**" }),
    ])
    expect(prov).not.toBeNull()
    expect(prov!.total).toBe(2)
    expect(prov!.orgCount).toBe(1)
    expect(prov!.repoCount).toBe(1)
    expect(prov!.suppressCount).toBe(0)
    expect(prov!.items).toEqual([
      { id: "org-1", label: "No raw SQL in handlers.", scope: "org" },
      { id: "repo-1", label: "Entry point is src/index.ts.", scope: "repo", pathGlob: "src/**" },
    ])
  })

  it("excludes suppress-polarity rule TEXT from items but counts it in the aggregate", () => {
    const prov = buildMemoryProvenance([
      entry({ id: "ctx-1", scope: "repo", rule: "Batch KV writes." }),
      entry({ id: "sup-1", scope: "org", polarity: "suppress", rule: "Silence the legacy lint warning." }),
    ])
    expect(prov!.total).toBe(2)
    expect(prov!.suppressCount).toBe(1)
    // The suppress entry is org-scoped but is NOT counted as a guardrail — the
    // per-scope counts cover only the VISIBLE (non-suppress) entries.
    expect(prov!.orgCount).toBe(0)
    expect(prov!.repoCount).toBe(1)
    // total === orgCount + repoCount + suppressCount for repo∪org scopes.
    expect(prov!.orgCount + prov!.repoCount + prov!.suppressCount).toBe(prov!.total)
    // Only the non-suppress entry is visible.
    expect(prov!.items).toHaveLength(1)
    expect(prov!.items[0]!.id).toBe("ctx-1")
    expect(JSON.stringify(prov)).not.toContain("Silence the legacy lint warning.")
  })

  it("truncates a long rule to a single line under the cap", () => {
    const long = "A ".repeat(200).trim() // 200 chars, no newlines needed
    const prov = buildMemoryProvenance([entry({ rule: `${long}\nsecond line` })])
    const label = prov!.items[0]!.label
    expect(label.length).toBeLessThanOrEqual(100)
    expect(label.endsWith("…")).toBe(true)
    expect(label).not.toContain("\n")
  })
})

describe("renderMemoryProvenance", () => {
  it("renders a collapsible Memory footer with the applied rules", () => {
    const prov = buildMemoryProvenance([
      entry({ id: "org-1", scope: "org", rule: "No raw SQL in handlers." }),
      entry({ id: "repo-1", scope: "repo", rule: "Entry point is src/index.ts.", pathGlob: "src/**" }),
    ])!
    expect(renderMemoryProvenance(prov)).toMatchInlineSnapshot(`
      "<sub>·</sub> <details><summary><b>Memory</b> · Grounded on 2 memories (1 org guardrail, 1 repo fact)</summary>

      - [org] No raw SQL in handlers.
      - [repo] \`src/**\` Entry point is src/index.ts.
      </details>"
    `)
  })

  it("notes suppressed rules as an aggregate count only (never their text)", () => {
    const prov = buildMemoryProvenance([
      entry({ id: "ctx-1", scope: "repo", rule: "Batch KV writes." }),
      entry({ id: "sup-1", scope: "org", polarity: "suppress", rule: "SILENCE-ME" }),
    ])!
    const md = renderMemoryProvenance(prov)!
    expect(md).toContain("Grounded on 2 memories (0 org guardrails, 1 repo fact)")
    expect(md).toContain("1 noise-reduction rule applied as context (text not shown).")
    expect(md).not.toContain("SILENCE-ME")
  })

  it("escapes angle brackets / ampersands in the rule + glob (no HTML injection)", () => {
    const prov = buildMemoryProvenance([entry({ id: "x", scope: "repo", rule: "Use <script> & </div> carefully." })])!
    const md = renderMemoryProvenance(prov)!
    expect(md).toContain("Use &lt;script&gt; &amp; &lt;/div&gt; carefully.")
    expect(md).not.toContain("<script>")
  })
})

describe("resolveAppliedMemoryProvenance (flag gate)", () => {
  const entries = [entry({ id: "repo-1", scope: "repo", rule: "Batch KV writes." })]

  it("returns undefined when the flag is off (byte-identical output guarantee)", () => {
    expect(resolveAppliedMemoryProvenance({} as Env, entries)).toBeUndefined()
    expect(resolveAppliedMemoryProvenance({ OPENCLAW_MEMORY_PROVENANCE: "shadow" } as Env, entries)).toBeUndefined()
  })

  it("returns the built provenance when the flag is on", () => {
    const prov = resolveAppliedMemoryProvenance({ OPENCLAW_MEMORY_PROVENANCE: "on" } as Env, entries)
    expect(prov).toBeDefined()
    expect(prov!.total).toBe(1)
    expect(prov!.items[0]!.id).toBe("repo-1")
  })

  it("returns undefined for the empty set even when the flag is on", () => {
    expect(resolveAppliedMemoryProvenance({ OPENCLAW_MEMORY_PROVENANCE: "on" } as Env, [])).toBeUndefined()
  })
})
