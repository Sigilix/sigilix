// ARC-186: the dep-vuln finding shape — a pure domain data type. Lives in
// `domain/` (not `app/`) so `render/` can import it without violating the
// inward dependency rule (render imports domain types only). COMPLIANCE.md §1.

import type { AdvisoryRecord } from "@/src/features/dep-vulns/domain/advisory-db"

export interface DepVulnFinding {
  ecosystem: "npm"
  package_name: string
  version: string
  source_path: string
  advisory_id: string
  advisory_source: AdvisoryRecord["source"]
  vulnerable_range: string
  patched_in: string
  severity: AdvisoryRecord["severity_class"]
  summary: string
  fix_guidance: string | null
  match_type: "range-vulnerable"
}
