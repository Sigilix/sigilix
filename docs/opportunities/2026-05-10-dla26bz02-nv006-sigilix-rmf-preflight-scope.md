# DLA26BZ02-NV006 - Sigilix RMF Preflight Proposal Scope

Date: 2026-05-10
Prepared for: 2026-05-11 scoping conversation
Product framing: Sigilix RMF Preflight
Topic: DLA26BZ02-NV006, "AI-Assisted RMF Pre-Adjudication for Research, Development, and Rapid Prototyping Environments"
Working posture: Arc & Anchor-only SBIR pursuit, with informal RMF reviewer input if available

## Executive Recommendation

Recommendation: pursue `DLA26BZ02-NV006` as the first-priority Arc & Anchor-only Sigilix opportunity, provided the team can keep the proposal unclassified, artifact-centric, synthetic/public-data based before award, and explicit that the system supports pre-adjudication only. It must not claim to automate an Authority to Operate (ATO), replace assessors, or reduce RMF governance authority.

Approval-likelihood priority: **#1 of 3** current Arc & Anchor-only SBIR targets.

Likelihood score for Arc & Anchor-only pursuit: `7 / 10`.

Planning estimate:

- Technical fit: `8 / 10`.
- Arc & Anchor-only proposal viability: `7 / 10`.
- Competitive Phase I proposal probability if a credible demo is built before submission: `45-60%`.
- Rough award odds: `25-40%`.

Why: the topic asks for AI-assisted, artifact-centric RMF package review with structured, confidence-scored findings, source traceability, and human attestation. Sigilix already has production evidence for artifact review, structured model outputs, deterministic security evidence channels, retrieval, queue-based execution, dedupe, and human review loops. The main gap is RMF-specific credibility, not base software capability.

## DSIP Identifiers And Links

- Topic code: [`DLA26BZ02-NV006`](https://www.dodsbirsttr.mil/topics/api/public/topics/e9ccfc68eff94a35b2a275308a38cd44_86496/details)
- Topic/application topicId: `e9ccfc68eff94a35b2a275308a38cd44_86496`
- Topic details API: <https://www.dodsbirsttr.mil/topics/api/public/topics/e9ccfc68eff94a35b2a275308a38cd44_86496/details>
- DSIP topics app: <https://www.dodsbirsttr.mil/topics-app/>
- DLA instructions: <https://www.dodsbirsttr.mil/submissions/api/public/download?uploadId=1736714>
- Local source PDF attachment: [DLA26BZ02-NV006_DLA_SBIR_26.BZ_R2.pdf](source-pdfs/DLA26BZ02-NV006_DLA_SBIR_26.BZ_R2.pdf)
- Local extracted DLA source used for this scope: `/tmp/DLA_SBIR_26.BZ_R2.txt`
- Local fit scan used for this scope: `docs/opportunities/2026-05-10-dsip-active-topic-fit-scan.md`

## Funding, Dates, And Constraints

| Item | Current planning value |
| --- | --- |
| Program | SBIR |
| Topic status in scan | Pre-release |
| Open date | 2026-05-27 |
| Q&A close | 2026-06-10 |
| Close date | 2026-06-24 |
| Phase I cap | Not to exceed 12 months and $100,000 |
| Phase II cap | Not to exceed 24 months and $1,000,000 |
| Phase III | No specific SBIR funding; transition proposals may use non-SBIR funding and have no stated funding or duration limit |
| Contract shape | DLA Phase I is typically Firm-Fixed-Price; Phase II is typically FFP/Level-of-Effort |
| CMMC | Projected CMMC Level 2 (Self) |
| ITAR/EAR | Topic may be restricted under ITAR and/or EAR; foreign nationals may be restricted; a Technology Control Plan may be required during negotiations |
| Classified work | DLA does not accept classified proposals; Phase I is not typically awarded for classified work |
| Public release | DLA clause H-08 requires review and approval before public release of work-related information |
| CUI posture | If CUI or export-controlled information is accessed, expect DFARS 252.204-7012 and 252.204-7020 style safeguarding and assessment obligations |
| Foreign nationals | Disclose proposed foreign nationals, country of origin, visa/work permit, and SOW tasks; student or temporary visa holders are not approved under the general DLA text |

Immediate constraint conclusion:

- Phase 0 must use only synthetic and public artifacts.
- The proposal should state that Phase I starts in a controlled, government-approved R&D sandbox if provided, but the core methods can be demonstrated without real DLA RMF artifacts.
- The team should avoid any dependency on classified data, real CUI, export-controlled technical data, or agency-specific RMF packages before award.
- If selected, Arc & Anchor should be ready to produce a CMMC Level 2 self-assessment posture, foreign-national disclosure, export-control screening, and possibly a Technology Control Plan.

## What DLA Is Actually Asking For

The topic asks whether AI-enabled, human-attested analysis can improve RMF documentation quality and reduce rework in research, development, and rapid prototyping environments.

The expected capability should:

- Operate on submitted artifacts as primary inputs, not just a conversational chatbot.
- Analyze draft RMF artifacts such as control implementation statements and system architecture documents.
- Identify missing, inconsistent, or weak control implementation statements.
- Distinguish the presence of a control narrative from the sufficiency and clarity of supporting evidence.
- Generate structured, confidence-scored analytical feedback.
- Trace analytical findings back to source text.
- Require explicit human attestation before findings are treated as reviewed.
- Preserve existing RMF authority structures.
- Avoid automating authorization decisions.

Best interpretation: DLA wants a preflight quality gate for RMF packages, especially early R&D systems where documentation is immature and assessor bandwidth is scarce. This is closer to "linting, evidence review, and readiness scoring" than to "automated compliance certification."

## Product Thesis

`Sigilix RMF Preflight` is an AI-assisted, human-attested RMF artifact review tool for R&D teams preparing packages for formal cybersecurity review.

One-line positioning:

> Sigilix RMF Preflight ingests draft RMF packages, identifies missing or weak evidence, generates confidence-scored and source-linked feedback, and routes every finding through human attestation before it affects readiness decisions.

Core boundaries:

- It does not issue an ATO.
- It does not replace the Authorizing Official, Security Control Assessor, system owner, or cybersecurity governance chain.
- It does not adjudicate risk acceptance.
- It does not train on or require DLA-controlled artifacts for the pre-submission demo.
- It does help teams submit cleaner, more internally consistent documentation.

Proposal wedge:

- R&D teams move faster when poor RMF documentation is caught before formal review.
- Assessors spend less time rejecting incomplete packages and more time on substantive cyber risk.
- Human attestation keeps accountability with the cybersecurity authority.
- Source-linked findings reduce hallucination risk and make the tool auditable.

## Why Sigilix Fits

| DLA need | Sigilix production evidence to cite | Proposal framing |
| --- | --- | --- |
| Artifact-centric review | GitHub PR review, CI triage, SARIF evidence ingestion, diff-aware review | Sigilix already reviews structured artifacts and code evidence rather than relying only on chat |
| Structured confidence-scored feedback | Prompt schemas produce JSON verdicts, confidence values, categories, and anchored findings | RMF Preflight can reuse the same structured-output pattern for control findings |
| Source traceability | Inline PR comments are anchored to changed lines; SARIF findings retain path and line evidence | RMF findings should cite source artifact, section, control, excerpt hash, and evidence gap |
| Human accountability | GitHub review loop requests changes or approves; mention replies and review memory support human feedback | Phase I can add explicit attestation states: pending, accepted, rejected, needs assessor review |
| Deterministic evidence before LLM synthesis | Secret scan, dependency vulnerability scan, AST rules, deterministic checks, SARIF parser | RMF Preflight can separate deterministic checklist failures from AI-authored narrative critique |
| Retrieval over reference material | Existing Vectorize-backed retrieval over indexed repositories | Use NIST/RMF/OSCAL reference chunks and synthetic package chunks for grounded analysis |
| Secure webhook and queue operations | HMAC verification, GitHub App auth, queue-based execution, KV dedupe, Durable Object run state | Shows production maturity for long-running review jobs and auditable status |
| Audit and dedupe patterns | Review markers, run IDs, retry state, telemetry tags, stale-head guards | RMF Preflight can produce a review ledger and prevent duplicate or stale findings |
| Test maturity | Opportunity scan records `npm run build` passing with 87 test files and 1,677 tests | Cite as evidence that Sigilix is not a concept-only codebase |

Strongest existing code and docs to cite in the proposal narrative:

- `README.md`: Cloudflare Worker architecture, GitHub/Linear review workflows, Vectorize retrieval, queue-based execution.
- `src/lib/sarif-evidence/`: SARIF v2.1.0 parser, taxonomy, rendering, SBOM summary, path normalization.
- `src/lib/secret-scan.ts`: deterministic secret scanning with redaction and no raw-secret telemetry.
- `src/lib/dep-vulns/`: dependency advisory scanning and rendering.
- `src/lib/ast-rules/`: AST-based deterministic rule pack.
- `src/do/pr-review-run.ts` and `src/do/README.md`: Durable Object run state, dedupe, retry, and status patterns.
- `docs/superpowers/specs/2026-05-06-arc-188-sarif-evidence-design.md`: design precedent for standard evidence ingestion.
- `docs/superpowers/specs/2026-05-07-arc-190-durable-objects-webhook-ingest-design.md`: design precedent for auditable run orchestration.

Important language discipline:

- Say Sigilix has production evidence for artifact review, structured findings, deterministic security evidence, retrieval, and human review.
- Do not say Sigilix already performs RMF adjudication.
- Say RMF Preflight is a focused SBIR extension that adapts proven Sigilix patterns to RMF documentation quality.

## Phase 0: Pre-Submission Demo Sprint

Phase 0 is unfunded internal work before DSIP submission. Its purpose is to make the Phase I proposal credible, reduce reviewer risk, and create screenshots, metrics, and a demo script.

Recommended Phase 0 schedule:

| Date range | Workstream | Exit artifact |
| --- | --- | --- |
| 2026-05-11 to 2026-05-14 | RMF artifact model and synthetic packet design | Synthetic RMF packet schema, seeded defect taxonomy, selected controls |
| 2026-05-15 to 2026-05-19 | Parser and reference corpus | Ingest NIST/RMF references, OSCAL examples, synthetic SSP/control statements |
| 2026-05-20 to 2026-05-23 | Analyzer and finding schema | Structured JSON findings with control ID, source span, issue type, severity, confidence, recommendation |
| 2026-05-24 to 2026-05-26 | Attestation and demo UI/report | Human-attested review report, readiness summary, audit ledger |
| 2026-05-27 to 2026-06-09 | Proposal asset integration and Q&A | Screenshots, metrics table, Q&A draft, technical volume language |
| 2026-06-10 | DSIP Q&A close | Final questions submitted before deadline |
| 2026-06-24 | DSIP close | Proposal submitted |

Minimum Phase 0 demo scope:

- Synthetic RMF package with 8-12 artifacts:
  - System overview.
  - Architecture description.
  - Data flow summary.
  - Asset inventory.
  - Boundary narrative.
  - Control implementation statements for a selected subset of controls.
  - Inherited controls table.
  - POA&M sample.
  - Evidence attachment index.
  - Optional SARIF/SBOM/IaC evidence file.
- Seeded issues:
  - Missing evidence.
  - Weak control statement that asserts compliance without implementation detail.
  - Inconsistent component names across architecture and control narrative.
  - Ambiguous inherited control responsibility.
  - Control narrative unsupported by evidence attachment.
  - High-confidence evidence present but not linked to the control.
  - Unclear boundary or external dependency.
- Analyzer output:
  - Readiness score by artifact and control.
  - Findings with source traceability.
  - Confidence and reason.
  - Suggested documentation repair.
  - "Not an ATO" guardrail label.
  - Human attestation state.
- Evaluation:
  - Recall against seeded issues.
  - False-positive review rate.
  - Source-link accuracy.
  - Time-to-review comparison against manual review of the synthetic packet.

Phase 0 success bar:

- Demo identifies at least 80% of seeded high-priority issues.
- At least 90% of generated findings include a valid source artifact and source span.
- 100% of findings require explicit human attestation before export.
- No real CUI, ITAR-controlled technical data, customer secrets, or DLA artifacts are used.
- Proposal screenshots are unclassified, non-sensitive, and suitable for public release review if needed.

## Phase I (P1): Feasibility Prototype

Phase I should be scoped as a feasibility demonstration, not a production deployment. The topic allows up to 12 months and $100,000. The proposal should use the full cap unless there is a strategic reason not to, because RMF domain modeling, evaluation, and documentation will consume the available budget quickly.

Phase I objective:

> Demonstrate that Sigilix RMF Preflight can ingest draft RMF artifacts in a controlled R&D setting, identify gaps and inconsistencies, generate source-linked confidence-scored feedback, and require human attestation before findings are treated as reviewed.

### Phase I Work Packages

| WP | Name | Months | Budget logic | Key outputs |
| --- | --- | --- | --- | --- |
| WP1 | RMF scope, control rubric, and evaluation design | 1-2 | About $12k for PI/research time and informal reviewer sessions | Control subset, artifact taxonomy, issue taxonomy, evaluation rubric |
| WP2 | Artifact ingestion and normalization | 1-4 | About $16k for engineering and test fixtures | Parsers for markdown, JSON/YAML OSCAL-like artifacts, CSV evidence indexes, PDF/DOCX stretch parser if feasible |
| WP3 | Pre-adjudication analysis engine | 2-6 | About $28k for deterministic checks, retrieval, model prompts, and structured output validation | Missing/weak/inconsistent control findings, evidence sufficiency checks, source traceability |
| WP4 | Human attestation and audit workflow | 3-7 | About $16k for UI/API/report workflow | Attestation states, reviewer notes, exportable report, immutable-ish audit log |
| WP5 | Quantitative and qualitative assessment | 5-9 | About $18k for test packets, seeded-defect evaluation, manual comparison, analysis | Rework-reduction estimate, precision/recall table, confidence calibration, limitations |
| WP6 | Sandbox hardening, documentation, and Phase II transition plan | 8-12 | About $10k for packaging, docs, final report, transition plan | Functional prototype package, methods/limits doc, final report, Phase II plan |

Total budget logic: $100,000. Most funding should go to technical labor. Keep cloud/tool spend small. Avoid paid subcontract dependency unless a small RMF SME review budget is explicitly allowable and does not create proposal friction. DLA does not participate in TABA, so do not rely on TABA for proposal support.

### Phase I Deliverables

Topic-specific deliverables:

- Functional prototype.
- Documentation of methods and limitations.
- Demonstration that analytical findings can be traced to source text.
- Quantitative and qualitative assessment of potential reductions in rework.
- Recommendations for Phase II.

DLA standard deliverables to plan for:

- Plan of Action and Milestones (POAM).
- Initial Project Summary, one page and public-viewable.
- Monthly Status Reports.
- Monthly or more frequent project reviews as set at the Post Award Conference.
- Draft Final Report with major accomplishments, business case, commercialization strategy, transition plan, and Phase II path.
- Final Report.
- Final Project Summary, one page and public-viewable.
- Applicable patent documentation.
- Optional Phase II proposal.

### Phase I Success Metrics

Use metrics that can be measured without claiming operational authorization authority:

- Source traceability: at least 90% of findings point to a source artifact, section, paragraph, table row, or excerpt hash.
- Seeded issue recall: at least 80% for high-priority synthetic defects.
- Unsupported-finding rate: less than 25% of findings rejected by a human reviewer as unsupported by source text.
- Evidence distinction: at least 80% accuracy distinguishing "control narrative present" from "sufficient supporting evidence present" on the synthetic test set.
- Human attestation coverage: 100% of exported findings have an attestation state.
- Readiness report latency: target under 10 minutes for a small R&D package in the demo environment.
- Rework signal: show a plausible reduction in manual rework by comparing initial and corrected synthetic packages, e.g. fewer missing evidence links, fewer inconsistent control statements, and faster reviewer pass.
- Safety: zero outputs that state or imply final authorization, ATO approval, or risk acceptance.

### Phase I Technical Shape

Recommended architecture for Phase I:

1. Ingest package artifacts into a normalized package graph.
2. Parse structured artifacts first: OSCAL JSON/YAML, CSV evidence index, markdown, simple JSON.
3. Chunk and embed public references and package artifacts for grounded retrieval.
4. Run deterministic checks before model analysis:
   - Required fields present.
   - Control IDs recognized.
   - Evidence links resolve.
   - Component names align across artifacts.
   - Inherited controls have source/provider fields.
   - POA&M items map to controls and risks.
5. Run model-assisted analysis against retrieved control/reference context.
6. Validate model output against a strict schema.
7. Store finding records with source references and confidence.
8. Route findings to human attestation.
9. Export a readiness report and machine-readable JSON.

## Phase II (Ph2): Scaled Pilot And Transition Prototype

Phase II should be framed as scaling a validated Phase I prototype across multiple R&D programs and enterprise RMF workflows while preserving cybersecurity authority. It should not become a generic GRC chatbot.

Phase II objective:

> Mature Sigilix RMF Preflight into a deployable, multi-program RMF documentation quality platform that integrates with enterprise workflows, supports continuous documentation improvement, and gives assessors auditable, source-linked, human-attested pre-adjudication packages.

### Phase II Modules

| Module | Purpose | Transition value |
| --- | --- | --- |
| Multi-program workspace | Separate packages, programs, reviewers, and control baselines | Lets DLA pilot across multiple R&D efforts without data commingling |
| OSCAL-native package model | Support OSCAL catalog, profile, component definition, SSP, assessment plan, assessment results, and POA&M-style artifacts | Aligns with NIST machine-readable compliance direction |
| Evidence graph | Link controls, statements, components, evidence attachments, risks, POA&M items, and inherited controls | Makes documentation gaps visible and auditable |
| Human attestation console | Reviewer workflow for accept, reject, defer, needs-assessor-review, and rationale | Preserves authority and creates accountability |
| Continuous documentation monitor | Re-run checks when architecture, SBOM, SARIF, IaC, or package docs change | Supports high-velocity development environments |
| Enterprise RMF adapters | Export/import via OSCAL JSON/YAML and, if authorized, API/file adapters for government RMF systems | Makes Phase II transition practical without locking to one tool |
| Evaluation and model governance suite | Regression tests, prompt/version tracking, confidence calibration, hallucination checks, source-link audits | Gives government reviewers confidence in AI behavior |
| Secure deployment package | Hardened self-hosted or approved-cloud deployment with RBAC, audit logging, retention policy, and CUI-ready controls | Supports DLA security expectations and commercial regulated customers |
| Management reporting | Dashboard for rework rate, common deficiencies, package readiness, and reviewer workload | Shows mission value beyond individual package review |

### Phase II Success Metrics

- Support at least 3 distinct synthetic or government-approved R&D package types.
- Reduce unresolved preflight deficiencies between first and second package pass by at least 40% in pilot data.
- Maintain at least 90% source-link validity.
- Keep human rejection of unsupported AI findings below 20% after calibration.
- Produce exportable evidence packages suitable for formal assessor review.
- Demonstrate role-based access control, audit logging, and data segregation.
- Show a transition path to DLA R&D organizations, DoD innovation organizations, and commercial regulated sectors.

### Phase II Transition Story

Primary DLA transition:

- Start with R&D and rapid prototyping teams that repeatedly submit incomplete RMF documentation.
- Use Sigilix RMF Preflight as a pre-submission quality gate before formal cybersecurity review.
- Provide assessors with cleaner packages, source-linked issue history, and attested remediation records.
- Integrate through exported artifacts first; add direct workflow integrations only after security approval.

DoD adjacent transition:

- DoD labs, acquisition programs, and innovation organizations with fast-moving prototypes.
- Platform teams that need continuous documentation improvement alongside DevSecOps.
- Programs preparing packages for formal RMF review but not ready to automate final authorization decisions.

Commercial dual-use transition:

- FedRAMP-oriented SaaS vendors.
- CMMC and defense industrial base suppliers.
- Healthcare, finance, and infrastructure firms with formal security review gates.
- Internal GRC teams that need evidence-quality preflight checks before audits.

## Phase III: Productization And Dual-Use Commercialization

Phase III should be framed as production transition, not more feasibility research.

Phase III path:

- Deliver a production-level Sigilix RMF Preflight deployment for enterprise RMF workflows.
- Support DLA or other government insertion through non-SBIR funding.
- Maintain human authority, source traceability, and auditability as product differentiators.
- Offer deployment modes appropriate to data sensitivity:
  - Commercial SaaS for non-CUI commercial use.
  - Dedicated tenant for regulated customers.
  - Self-hosted or government-approved environment for CUI/export-controlled workflows.
- Productize repeatable integrations:
  - OSCAL import/export.
  - Evidence repository connectors.
  - DevSecOps and SARIF/SBOM ingestion.
  - RMF workflow package export.

Commercial packaging:

- `Preflight Core`: artifact ingestion, checks, report export.
- `Preflight Team`: attestation workflow, dashboards, package history.
- `Preflight Enterprise`: RBAC, audit exports, tenant isolation, API integrations, CUI-ready controls.

## Open-Source Tools, Standards, And Libraries

Use open standards and open-source components for the demo and Phase I where possible. Keep proprietary dependencies replaceable.

### RMF, Control, And Compliance Standards

- NIST SP 800-37 Rev. 2: RMF lifecycle and terminology.
- NIST SP 800-53 Rev. 5: security and privacy control catalog.
- NIST SP 800-53A Rev. 5: assessment methods and procedures.
- NIST SP 800-53B: control baselines, if baseline selection is needed.
- NIST SP 800-171 Rev. 3: CUI protection requirements relevant to CMMC Level 2 posture.
- OSCAL: machine-readable catalogs, profiles, component definitions, system security plans, assessment plans, assessment results, and POA&M-style information.
- SARIF v2.1.0: security scanner evidence interchange, already supported in Sigilix.
- SPDX or CycloneDX: SBOM inputs if supply-chain evidence is included.

### OSCAL And Compliance-As-Code Tooling

- NIST OSCAL schemas and model documentation: validation and data model reference.
- `usnistgov/OSCAL`: official OSCAL source and examples.
- NIST `oscal-cli`: schema validation and conversion candidate.
- `oscal-compass/compliance-trestle`: compliance-as-code authoring and OSCAL workflow candidate.
- FedRAMP automation examples: optional public sample patterns for OSCAL package structure; do not imply FedRAMP scope unless needed.
- OpenControl / compliance-masonry: useful historical compliance-as-code reference, but lower priority than OSCAL for this topic.

### Parser And Normalization Libraries

Recommended demo stack should stay TypeScript-friendly because Sigilix is TypeScript:

- `zod` or `ajv`: strict JSON schema validation for finding output and package manifests.
- `yaml`: parse OSCAL YAML and synthetic package manifests.
- `unified`, `remark`, and `mdast`: parse markdown control narratives and architecture docs.
- `mammoth`: optional DOCX text extraction for common RMF documentation formats.
- `pdf.js` or `pdf-parse`: optional PDF text extraction for public/synthetic artifacts.
- Existing Sigilix SARIF parser: reuse `src/lib/sarif-evidence/` patterns.
- Existing Sigilix path normalization and deterministic renderer patterns.

### Retrieval And Vector Storage

Phase 0 can start with the existing Sigilix retrieval pattern. For an open-source/self-hostable Phase I path, evaluate:

- `pgvector`: preferred if relational metadata, audit records, and embeddings should live together.
- `Qdrant`: preferred if a dedicated vector database with filtering and hybrid search becomes important.
- `Chroma`: useful for local notebooks and quick RAG experiments, less compelling for hardened deployment.
- SQLite plus `sqlite-vec` or a simple local embedding cache: acceptable for Phase 0 only if speed matters more than production fidelity.

Retrieval should be used for grounding and citation, not for final authority. Every finding still needs source traceability to the submitted package.

### Evaluation And Test Tools

- Existing Sigilix `vitest` test harness for deterministic parsers and schemas.
- `promptfoo`: prompt and model regression tests, red-team checks, and CI-friendly evaluation.
- `DeepEval`: LLM/agent test cases and trace-style grading if a Python-side eval harness is acceptable.
- `Ragas`: RAG faithfulness, context precision, and retrieval-quality checks.
- Hand-built seeded-defect evals: essential because RMF package quality has domain-specific failure modes generic eval tools will miss.
- Confusion-matrix reporting: true positives, false positives, false negatives by defect type and control family.

### Security And Evidence Inputs

- SARIF from Trivy, Semgrep, CodeQL, Kubescape, or other SARIF producers for optional security evidence.
- CycloneDX or SPDX SBOM for software inventory evidence.
- Gitleaks-compatible concepts for secret evidence, using Sigilix's current redacted secret-scan pattern where appropriate.
- OpenTelemetry-style structured events for audit and operational telemetry if Phase II needs observability.

## Demo Architecture

Recommended Phase 0 and Phase I architecture:

```text
Public references
  - NIST SP 800-37
  - NIST SP 800-53 / 53A / 53B
  - OSCAL schemas and examples
        |
        v
Reference index and control rubric

Synthetic RMF package
  - SSP/control statements
  - architecture narrative
  - inventory and data flows
  - inherited controls
  - evidence index
  - POA&M sample
  - optional SARIF/SBOM
        |
        v
Ingest and normalize
        |
        v
Package graph
  - controls
  - components
  - evidence
  - risks
  - source spans
        |
        +--> deterministic checks
        |
        +--> retrieval-grounded AI analysis
        |
        v
Finding validator
  - schema validation
  - source-link validation
  - confidence calibration
        |
        v
Human attestation workflow
        |
        v
Readiness report and audit ledger
```

Core output schema:

```json
{
  "findingId": "rmf-ac-2-001",
  "controlId": "AC-2",
  "artifact": "ssp.md",
  "sourceSpan": {
    "section": "AC-2 Account Management",
    "startLine": 42,
    "endLine": 49
  },
  "issueType": "weak-control-implementation-statement",
  "severity": "high",
  "confidence": 4,
  "claim": "The statement says account reviews occur but does not identify frequency, responsible role, or evidence artifact.",
  "evidenceGap": "Missing reviewer role, review cadence, and linked evidence.",
  "suggestedRepair": "Add review cadence, responsible role, authoritative account source, and evidence attachment reference.",
  "authorityBoundary": "Pre-adjudication only; not an authorization decision.",
  "attestation": {
    "state": "pending",
    "reviewer": null,
    "reviewedAt": null
  }
}
```

## Demo Data Plan

Allowed data:

- Public NIST publications and OSCAL references.
- Public OSCAL examples and schemas.
- Synthetic RMF artifacts generated by Arc & Anchor.
- Synthetic architecture diagrams and inventories.
- Synthetic SARIF/SBOM files.
- Public scanner examples if licenses permit.

Disallowed data for Phase 0:

- DLA CUI.
- Export-controlled technical data.
- Real DLA RMF packages.
- Customer RMF packages.
- Real system diagrams from sensitive environments.
- Real credentials, keys, logs, or vulnerability data from customer systems.
- Classified data.

Synthetic packet design:

- Create a fictional R&D prototype, e.g. "Rapid Parts Forecasting Prototype."
- Give it plausible but invented components:
  - Web UI.
  - API.
  - Postgres database.
  - Object storage.
  - CI pipeline.
  - Identity provider.
  - External telemetry service.
- Select 20-30 controls for the demo across AC, AU, CM, IA, RA, SA, SC, and SI.
- Create two package versions:
  - `v0`: seeded with known defects.
  - `v1`: corrected after preflight feedback.
- Maintain a ground-truth label file:
  - defect ID.
  - control ID.
  - artifact.
  - expected severity.
  - expected source span.
  - acceptable repair guidance.

Evaluation plan:

- Run the analyzer against `v0`.
- Compare findings to ground truth.
- Have a human reviewer accept/reject findings.
- Apply repairs to produce `v1`.
- Re-run analyzer and show reduced open deficiencies.
- Export before/after readiness reports.

## Proposal Differentiators

- Artifact-first, not chatbot-first.
- Human-attested, not automated authorization.
- Deterministic checks separated from AI-authored analysis.
- Source traceability for every actionable finding.
- Built on production Sigilix patterns instead of a one-off prototype.
- Synthetic-data safe for proposal review while extensible to government-approved sandbox artifacts.
- OSCAL-aware path for Phase II interoperability.
- Clear transition to dual-use regulated compliance markets.

## Primary Risks And Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| RMF domain credibility is thin | Reviewers may see this as generic AI compliance | Get informal RMF reviewer input; use precise RMF terms; cite NIST 800-37/53/53A; scope to pre-adjudication |
| ITAR/EAR restrictions | Contracting friction and staffing limits | Keep Phase 0 public/synthetic; disclose personnel; prepare Technology Control Plan outline |
| CMMC Level 2 self | Award readiness friction | Prepare a Level 2 self-assessment posture, SSP, POA&M, access control, audit logging, and CUI boundary plan |
| Hallucinated findings | Assessor trust failure | Require source links, deterministic checks, schema validation, confidence calibration, and human attestation |
| Overclaiming ATO automation | Proposal could be rejected as governance risk | Use "preflight", "pre-adjudication", "readiness", and "documentation quality"; never "auto-ATO" |
| Phase I budget too small | Scope creep could dilute delivery | Limit control subset, artifact types, and integrations; focus on measurable feasibility |
| Government sandbox ambiguity | Phase I may require data access we do not control | Ask DSIP whether synthetic/public artifacts are acceptable until sandbox access is provided |
| Existing Sigilix is code-review oriented | Fit may look indirect | Frame reusable capabilities: artifact review, evidence ingestion, structured findings, human workflow, audit |

## Go/No-Go Checklist

Go if all are true by the internal proposal gate:

- Phase 0 demo can be completed by 2026-05-26.
- The demo uses only synthetic/public artifacts.
- Findings are source-linked and schema-validated.
- Human attestation is visible in the demo.
- Proposal language clearly says "not an ATO" and "preserves RMF authority."
- At least one RMF-literate reviewer can sanity-check the control rubric before submission, even informally.
- Arc & Anchor can describe a credible CMMC Level 2 self-assessment path.
- Arc & Anchor can describe an ITAR/EAR personnel and data-control plan.
- The Phase I plan fits within $100,000 without relying on a formal subcontractor.
- DSIP Q&A does not reveal a hard requirement for existing DLA artifacts before award.

No-go or pause if any are true:

- DLA requires real historical RMF artifacts for proposal evaluation and will not accept synthetic/public feasibility evidence.
- DLA requires a formal partner, cleared facility, or classified work for Phase I.
- The team cannot produce a demo before the proposal window opens.
- The product framing drifts into final authorization, automated risk acceptance, or assessor replacement.
- CMMC/ITAR requirements cannot be addressed credibly enough for contract negotiation.
- No one can review RMF terminology and artifact assumptions before submission.

## DSIP Q&A Questions

Submit before the 2026-06-10 Q&A close.

1. For Phase I feasibility, will DLA accept a demonstration using synthetic and public RMF artifacts until access to a government-approved R&D sandbox or historical artifacts is available?
2. What qualifies as a "government-approved R&D sandbox" for this topic, and is DLA expected to provide access after award?
3. Are offerors expected to use real historical RMF packages in Phase I, or may they use redacted, synthetic, or representative artifacts?
4. Which RMF artifact types are highest priority for Phase I: control implementation statements, SSP sections, architecture documents, inherited controls, POA&M items, assessment plans, assessment results, or evidence indexes?
5. Is OSCAL JSON/YAML an acceptable or preferred interchange format for prototype artifacts and Phase II transition?
6. Should the Phase I prototype cover a small subset of controls deeply, or a broader baseline shallowly?
7. How should offerors define and measure "potential reductions in rework" for Phase I?
8. What minimum human attestation behavior does DLA expect: approval of each finding, approval of the final report, role-based reviewer signatures, or another mechanism?
9. Should confidence scoring be calibrated against human assessor labels, synthetic seeded defects, or DLA-provided examples?
10. Does the projected CMMC Level 2 (Self) requirement apply at proposal submission, before award, or before access to CUI/export-controlled artifacts?
11. For this topic, what ITAR/EAR restrictions should offerors assume for unclassified synthetic demos, public references, and prototype code?
12. Are foreign nationals categorically restricted from all technical work on this topic, or only work involving controlled technical data?
13. Would DLA prefer a self-hosted deployment, government cloud deployment, or vendor-managed environment for Phase II?
14. Are integrations with existing enterprise RMF systems expected in Phase II, and if so which workflow or file interfaces should be targeted first?
15. Are there public sample artifacts, templates, or redacted examples DLA recommends for aligning a Phase I demo with assessor expectations?
16. How should public release restrictions under DLA clause H-08 apply to screenshots, demo videos, papers, or marketing material produced from synthetic artifacts?

## Proposal Narrative Skeleton

Problem:

R&D teams often submit incomplete or inconsistent RMF documentation, causing avoidable rework and consuming scarce assessor time.

Innovation:

Sigilix RMF Preflight combines deterministic artifact checks, retrieval-grounded AI analysis, strict source traceability, confidence scoring, and human attestation to identify RMF package deficiencies before formal review.

Technical approach:

Ingest draft artifacts, normalize them into a package graph, run deterministic quality checks, retrieve relevant NIST/RMF context, generate structured findings, validate each finding against source text, and route findings through human attestation before producing a readiness report.

Phase I result:

A functional prototype and evaluation showing whether AI-assisted pre-adjudication can reduce package rework in R&D environments without requiring an ATO or changing RMF authority.

Phase II result:

A scaled multi-program prototype integrated with enterprise RMF workflows and continuous documentation improvement.

Commercial result:

A dual-use RMF and regulated-compliance preflight product for government R&D, defense industrial base suppliers, FedRAMP-oriented SaaS vendors, and other regulated organizations.

## References For Implementation Planning

- NIST OSCAL model documentation: <https://pages.nist.gov/OSCAL-Reference/models/>
- NIST OSCAL GitHub repository: <https://github.com/usnistgov/OSCAL>
- NIST OSCAL CLI: <https://pages.nist.gov/oscal-cli/>
- NIST SP 800-37 Rev. 2: <https://csrc.nist.gov/pubs/sp/800/37/r2/final>
- NIST SP 800-53 Rev. 5: <https://csrc.nist.gov/Pubs/sp/800/53/r5/upd1/Final>
- NIST SP 800-53A Rev. 5: <https://csrc.nist.gov/pubs/sp/800/53/a/r5/final>
- NIST SP 800-171 Rev. 3: <https://csrc.nist.gov/pubs/sp/800/171/r3/final>
- Compliance Trestle: <https://github.com/oscal-compass/compliance-trestle>
- OpenControl: <https://open-control.org/>
- pgvector: <https://github.com/pgvector/pgvector>
- Qdrant documentation: <https://qdrant.tech/documentation/>
- Chroma docs: <https://docs.trychroma.com/>
- promptfoo docs: <https://www.promptfoo.dev/docs/intro/>
- DeepEval: <https://deepeval.com/>
- Ragas: <https://www.ragas.io/>
