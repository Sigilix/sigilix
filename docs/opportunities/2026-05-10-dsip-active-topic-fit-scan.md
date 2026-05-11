# DSIP Active Topic Fit Scan For Arc And Anchor Repositories

Date: 2026-05-10 America/Los_Angeles
Status: Working opportunity scan, retouched for Arc & Anchor-only pursuit
Source: DSIP Topics app public API, active/pre-release topics
Scope scanned: 158 active or pre-release topics

## Executive Readout

This version assumes **Arc & Anchor must apply without a formal research institution partner, defense
prime, university lab, or funded subcontractor**. We can still ask outside people for informal review,
but the proposal strategy should not depend on anyone else satisfying eligibility, workshare, or
technical credibility requirements.

That constraint changes the ranking materially:

- **STTR topics are out of scope** unless we later add a qualifying research institution. They require
  a formal research partner with funded workshare, so they do not fit an Arc & Anchor-only plan.
- **Normal Phase I SBIR topics are the highest-probability path** because the Government expects the
  feasibility proof to be built during Phase I.
- **Direct-to-Phase-II SBIR topics are still possible but lower probability** because they expect
  Phase-I-equivalent evidence before award.
- **CMMC/ITAR-heavy topics are possible but should be treated as higher-friction** unless the demo is
  clearly unclassified, synthetic-data based, and bounded.

The strongest current repo-to-topic fits are:

1. **DLA26BZ02-NV006: AI-Assisted RMF Pre-Adjudication for Research, Development, and Rapid
   Prototyping Environments**
   - Best Arc & Anchor-only Sigilix path.
   - SBIR, not STTR.
   - Normal Phase I, not Direct-to-Phase-II.
   - Funding: Phase I up to $100,000; Phase II up to $1,000,000.
   - Strong fit with Sigilix review, evidence, audit, and human-attestation patterns.
2. **DLA26BZ02-NV005: Strengthening Defensive Cybersecurity and Penetration Testing Through Agentic AI
   and Automation**
   - Strong fit for Sigilix's agentic/security direction.
   - SBIR, not STTR.
   - Normal Phase I.
   - Funding: Phase I up to $100,000; Phase II up to $1,000,000.
   - Needs careful cyber-safety scoping and a controlled, defensive lab demo.
3. **DLA26BZ02-NV010: Enhancing Tertiary Manufacturing Capacity Utilization with Secure Data Practices**
   - Best RubberFit manufacturing-operations fit.
   - SBIR, not STTR.
   - Normal Phase I.
   - Funding: Phase I up to $100,000; Phase II up to $1,000,000.
   - No ITAR flag in DSIP detail.
4. **OSW26BZ02-DV003: Generative AI for Secure Workflow Automation and Compliance**
   - Strong technical fit for Sigilix SecureFlow.
   - SBIR, not STTR.
   - Direct-to-Phase-II, so lower probability without prior defense workflow evidence.
   - Funding: Direct-to-Phase-II up to $2,000,000 over 12 months.
5. **DLA26BZ02-NV004: Enterprise Digital Thread with Mission-Aware Decision Intelligence**
   - Adjacent to RubberFit, Predict Market Bot, and Sigilix.
   - SBIR, not STTR.
   - Normal Phase I, but enterprise integration and DLA-system specificity make it harder.
   - Funding: Phase I up to $100,000; Phase II up to $1,000,000.

Excluded despite strong technical fit:

- **DON26TZ01-NV008: Automated Software Test Generation and Augmentation for Improved Debloating**
  - Program type: STTR.
  - Problem: requires a formal research institution partner and workshare.
  - Arc & Anchor-only recommendation: do not pursue this round.

Bottom line:

> If the company-only constraint is firm, pursue `DLA26BZ02-NV006` first, `DLA26BZ02-NV005` second,
> and `DLA26BZ02-NV010` third. Keep `OSW26BZ02-DV003` as a separate stretch only if we can build a
> strong demo and clearly show existing production Sigilix evidence. Do not spend proposal time on
> STTR topics unless a formal research institution partner becomes available.

## Funding Snapshot

| Rank | Topic | Program | Proposal Path | Funding Cap | Duration Notes |
| --- | --- | --- | --- | --- | --- |
| 1 | `DLA26BZ02-NV006` | SBIR | Phase I -> Phase II | Phase I: up to $100,000. Phase II: up to $1,000,000. | Phase I up to 12 months; Phase II up to 24 months. |
| 2 | `DLA26BZ02-NV005` | SBIR | Phase I -> Phase II | Phase I: up to $100,000. Phase II: up to $1,000,000. | Phase I up to 12 months; Phase II up to 24 months. |
| 3 | `DLA26BZ02-NV010` | SBIR | Phase I -> Phase II | Phase I: up to $100,000. Phase II: up to $1,000,000. | Topic text has a duration inconsistency: Phase I header says 6 months, body says within 12 months. Ask in Q&A. Phase II up to 24 months. |
| 4 | `OSW26BZ02-DV003` | SBIR | Direct-to-Phase-II | D2P2: up to $2,000,000. | No Phase I award; requires Phase-I-equivalent feasibility evidence. SCO D2P2 period of performance is 12 months. |
| 5 | `DLA26BZ02-NV004` | SBIR | Phase I -> Phase II | Phase I: up to $100,000. Phase II: up to $1,000,000. | DLA general cap is Phase I up to 12 months; Phase II up to 24 months. Topic does not restate dollar caps in the body. |
| 6 | `DON26BZ01-NV013` | SBIR | Phase I -> Phase II | Phase I: up to $240,000 total: $140,000 Base + $100,000 Option. Phase II: up to $2,000,000. | Navy Phase I Base and Option are exactly 6 months each. |
| 7 | `SF254-D1201` | SBIR | Direct-to-Phase-II | D2P2: up to $1,500,000. | No Phase I award; max period of performance is 12 months. |
| Excluded | `DON26TZ01-NV008` | STTR | Phase I -> Phase II | Phase I: up to $240,000 total: $140,000 Base + $100,000 Option. Phase II: up to $2,000,000. | Attractive funding/fit, but STTR requires a formal research institution partner. |

## Repository Evidence Inventory

### Sigilix

Repo: `Arc-and-Anchor/sigilix`

Relevant evidence:

- Production Cloudflare Worker for GitHub and Linear automation.
- Multi-agent PR review with specialist reviewers and synthesis.
- Retrieval over indexed repositories.
- Structured JSON model outputs.
- GitHub App auth, HMAC webhook verification, queue-based execution, KV dedupe.
- CI triage, PR overview, issue triage, and mention replies.
- Security evidence channels: secret scanning, AST rules, dependency vulnerabilities, SARIF.
- Current verification evidence: `npm run build` passes with 87 test files and 1,677 tests.

Best proposal directions:

- automated software test generation;
- secure AI code modernization;
- AI-assisted RMF/compliance pre-review;
- agentic cybersecurity in controlled labs;
- secure workflow automation.

### RubberFit

Repos: `Arc-and-Anchor/rubberfit`, `Arc-and-Anchor/Rubberfit-Desktop`

Relevant evidence:

- Industrial nesting engine and manufacturing CRM.
- Rust layout engine with 2D geometry, collision detection, packing, and waste calculations.
- Inventory, suppliers, procurement, purchase orders, reorder intelligence, role-based access control.
- Waste analytics, material utilization, cost tracking, and dashboards.
- Desktop Tauri app for AutoNest and Free Roam packing workflows.

Best proposal directions:

- manufacturing capacity discovery;
- supply-chain readiness;
- manufacturing optimization;
- digital-thread-light operations tooling;
- cut/waste/material utilization analytics.

### Predict Market Bot

Repo: `predict-market-bot`

Relevant evidence:

- Forecasting, Bayesian/risk/quant formulas, adaptive weights.
- Polymarket client, news/Reddit parsing, market comparison.
- Decision support and signal aggregation patterns.

Best proposal directions:

- investment and trend decision support;
- risk scoring;
- commercial-derived insight aggregation.

Weakness:

- It is finance/market oriented, not yet a defense S&T decision platform.

### ARC3D

Repo: `Arc-and-Anchor/ARC3D`

Current evidence:

- README-only placeholder for RubberFit 3D.

Best proposal directions:

- none yet as primary evidence.

Do not lean on ARC3D for 3D/modeling topics unless a real demo is built first.

## Ranked Topic Shortlist Under Arc & Anchor-Only Constraint

Scoring rule:

- Exclude STTR topics unless a formal research institution partner is available.
- Favor normal Phase I SBIR over Direct-to-Phase-II.
- Favor topics where existing Sigilix/RubberFit code is already credible evidence.
- Penalize topics that need classified workflows, government-specific system access, or deep defense
  domain proof before award.
- Treat probability ranges as rough proposal-planning estimates, not award predictions.

### 1. DLA26BZ02-NV006: AI-Assisted RMF Pre-Adjudication For R&D Environments

Status: Pre-release
Open date: 2026-05-27
Close date: 2026-06-24
Q&A close: 2026-06-10
Program: SBIR
Phase path: Phase I / Phase II / Sequential Phase II
Funding cap: Phase I up to $100,000; Phase II up to $1,000,000
CMMC: Level 2 self
ITAR in DSIP detail: true
Primary repo fit: Sigilix and SecureFlow
Fit rating: **8 / 10 technical, 7 / 10 Arc & Anchor-only probability**

Why this fits:

- The topic asks for AI-assisted, artifact-centric RMF pre-adjudication.
- Sigilix already does artifact review, structured comments, evidence injection, and human review.
- The SecureFlow OSW proposal draft already defines compliance, risk, audit, and policy-as-code
  patterns that can be adapted here.
- It is normal Phase I, so lack of prior defense SME evidence is less fatal than OSW Direct-to-Phase-II.
- It is SBIR, not STTR, so there is no mandatory research institution workshare.

Best product framing:

> Sigilix RMF Preflight: an AI-assisted, human-attested RMF artifact review tool that ingests draft RMF
> packages, identifies gaps and inconsistencies, generates confidence-scored feedback, and preserves
> cybersecurity authority through explicit human attestation.

Existing evidence to cite:

- Sigilix structured reviews and evidence channels;
- security finding taxonomy;
- SARIF/dependency/security evidence;
- human-in-the-loop review;
- queue/dedupe/audit patterns.

Why it can be Arc & Anchor-only:

- We can build the Phase I demo with public NIST/RMF concepts and synthetic artifacts.
- A CIO or compliance reviewer can help as an informal reviewer without becoming a required partner.
- The proposal can state that the tool supports RMF review and pre-adjudication, not final ATO
  authority.

Phase I demo to build:

- public/synthetic RMF artifact packet;
- OSCAL/NIST seed corpus;
- gap and inconsistency checker;
- confidence-scored findings;
- human attestation workflow;
- audit ledger;
- "not an ATO" guardrails.

Main gaps:

- RMF domain expertise;
- customer-approved sandbox requirement;
- CMMC/RMF terminology and artifacts must be precise.

Chance estimate if Arc & Anchor builds the demo alone:

- Technical viability: **70-80%**
- Competitive Phase I proposal: **45-60%**
- Award odds: **25-40%**

Recommendation: **Highest-priority company-only topic.**

### 2. DLA26BZ02-NV005: Agentic AI For Defensive Cybersecurity And Penetration Testing

Status: Pre-release
Open date: 2026-05-27
Close date: 2026-06-24
Q&A close: 2026-06-10
Program: SBIR
Phase path: Phase I / Phase II / Sequential Phase II
Funding cap: Phase I up to $100,000; Phase II up to $1,000,000
CMMC: Level 2 self
ITAR in DSIP detail: true
Primary repo fit: Sigilix
Fit rating: **7.5 / 10 technical, 6.5 / 10 Arc & Anchor-only probability**

Why this fits:

- The topic asks for an agentic AI framework for cybersecurity task automation.
- Sigilix already has agent orchestration, security specialists, evidence channels, and human oversight.
- Phase I only requires a foundational task prototype such as automated network enumeration and a
  researcher agent.
- It is SBIR, not STTR, so a university or research institution is not required.

Best product framing:

> Sigilix CyberRange Agents: a controlled, human-supervised agentic cybersecurity framework for
> research, enumeration, vulnerability validation, and defensive assessment in isolated lab
> environments.

Existing evidence to cite:

- multi-agent architecture;
- security review;
- secret scan, dependency vulnerability, SARIF evidence;
- queue-based long-running work;
- structured outputs and human review.

Phase I demo to build:

- local intentionally vulnerable lab network;
- researcher agent summarizing public CVE/tool guidance;
- enumerator agent using safe read-only tools;
- evidence report;
- strict allowlist and non-exploit default;
- human approval before active validation.

Main gaps:

- true penetration-testing automation not built;
- cyber safety and misuse controls must be very clear;
- lack of a defense/security SME weakens team credibility.

Chance estimate if Arc & Anchor builds the demo alone:

- Technical viability: **65-75%**
- Competitive Phase I proposal: **40-55%**
- Award odds: **20-35%**

Recommendation: **Good second choice if we can keep the demo defensive, auditable, and non-exploit
by default.**

### 3. DLA26BZ02-NV010: Enhancing Tertiary Manufacturing Capacity Utilization With Secure Data Practices

Status: Pre-release
Open date: 2026-05-27
Close date: 2026-06-24
Q&A close: 2026-06-10
Program: SBIR
Phase path: Phase I / Phase II / Sequential Phase II
Funding cap: Phase I up to $100,000; Phase II up to $1,000,000
CMMC: Level 2 self
ITAR in DSIP detail: false
Primary repo fit: RubberFit
Fit rating: **7 / 10 technical, 6 / 10 Arc & Anchor-only probability**

Why this fits:

- The topic asks for a secure AI-driven system to map manufacturing capabilities and capacity from
  tertiary sources to defense manufacturing demands.
- RubberFit already has manufacturing operations, inventory, procurement, suppliers, utilization, and
  optimization concepts.
- No ITAR flag in the topic detail lowers the initial burden.
- It is SBIR, not STTR.

Best product framing:

> RubberFit CapacityNet: a secure manufacturing capacity discovery and matching system that maps
> institutional fabrication capabilities, machine availability, materials, and constraints to urgent
> manufacturing demand.

Existing evidence to cite:

- manufacturing CRM;
- material inventory;
- supplier management;
- procurement;
- packing/optimization engine;
- RBAC and operational dashboards.

Why it can be Arc & Anchor-only:

- The Phase I demo can use synthetic manufacturers, synthetic capacity data, and RubberFit-style
  operations models.
- RubberFit gives us a concrete manufacturing software story without needing a university partner.
- A customer discovery letter would help, but the topic does not appear to require a formal partner.

Phase I demo to build:

- synthetic dataset of educational/research institution machines and capabilities;
- demand profile matcher;
- secure data exchange model;
- legal framework template;
- dashboard showing capacity, fit score, and engagement workflow.

Main gaps:

- RubberFit is focused on rubber fabrication, not broad institutional manufacturing networks.
- Need manufacturing-partner discovery or at least credible synthetic demos.
- Defense manufacturing demand matching needs careful framing so it does not sound like generic CRM.

Chance estimate if Arc & Anchor builds the demo alone:

- Technical viability: **60-70%**
- Competitive Phase I proposal: **35-50%**
- Award odds: **20-35%**

Recommendation: **Best non-Sigilix opportunity; pursue only if we want a RubberFit SBIR track.**

### 4. OSW26BZ02-DV003: Generative AI For Secure Workflow Automation And Compliance

Status: Pre-release
Open date: 2026-05-27
Close date: 2026-06-24
Q&A close: 2026-06-10
Program: SBIR
Phase path: Direct to Phase II / Phase II / Sequential Phase II
Funding cap: Direct-to-Phase-II up to $2,000,000
CMMC: Level 1
ITAR in DSIP detail: true
Primary repo fit: Sigilix
Fit rating: **8 / 10 technical, 4 / 10 Arc & Anchor-only probability**

Why this fits:

- The topic asks for a secure enterprise GenAI platform for SCG, PPP, OPSEC, compliance, risk, and
  insider-threat workflows.
- Sigilix is already a production secure AI workflow system.
- The SecureFlow proposal draft maps this well.
- It is SBIR, not STTR, so no research institution partner is required.

Why it is risky:

- Direct-to-Phase-II requires Phase-I-equivalent evidence.
- The topic explicitly asks for classified/security process experience and government acumen.
- Without a defense/security SME, the team credibility section is exposed.
- The required workflows are more defense-process-specific than the existing Sigilix production
  workflows.

Chance estimate if Arc & Anchor builds the demo alone:

- Technical viability: **70-80%**
- Competitive Direct-to-Phase-II proposal: **25-40%**
- Award odds: **10-25%**

Recommendation:

- Keep as a stretch.
- Do not make it the only proposal.
- If pursued, submit from a separate `sigilix-secureflow` repo/demo so it looks like a focused product
  line, not an improvised repackaging of the GitHub bot.

### 5. DLA26BZ02-NV004: Enterprise Digital Thread With Mission-Aware Decision Intelligence

Status: Pre-release
Open date: 2026-05-27
Close date: 2026-06-24
Q&A close: 2026-06-10
Program: SBIR
Phase path: Phase I / Phase II / Sequential Phase II
Funding cap: Phase I up to $100,000; Phase II up to $1,000,000
CMMC: Level 2 self
ITAR in DSIP detail: true
Primary repo fit: RubberFit + Sigilix + Predict Market Bot
Fit rating: **6.5 / 10 technical, 4.5 / 10 Arc & Anchor-only probability**

Why this fits:

- The topic asks for federated data integration, mission dependency modeling, predictive/prescriptive
  analytics, and decision dashboards.
- RubberFit has operations data models and dashboards.
- Predict Market Bot has forecasting/risk primitives.
- Sigilix has AI workflow and evidence patterns.
- It is SBIR, not STTR.

Best product framing:

> Arc Mission Thread: a synthetic digital-thread decision cockpit that connects readiness signals,
> supplier constraints, manufacturing capacity, and mission-impact scoring.

Why it is hard:

- It references DLA enterprise systems, IL4/IL5, FedRAMP High, MuleSoft, ServiceNow, Celonis, Vertex AI,
  Oracle Cloud, and OT environments.
- This is an enterprise integration topic, not just a software product topic.
- Arc & Anchor would need to show credible enterprise architecture, not only a dashboard.

Chance estimate if Arc & Anchor builds the demo alone:

- Technical viability: **55-65%**
- Competitive Phase I proposal: **25-40%**
- Award odds: **10-25%**

Recommendation:

- Possible, but lower probability than RMF, CyberRange Agents, or RubberFit CapacityNet.
- Do not pursue unless the DLA topic language strongly favors small, synthetic Phase I feasibility demos
  after Q&A.

### 6. DON26BZ01-NV013: AI-Assisted Modernization And Optimization Of TMPC Software

Status: Open
Open date: 2026-05-06
Close date: 2026-06-03
Q&A close: 2026-05-20
Program: SBIR
Phase path: Phase I / Phase II / Sequential Phase II
Funding cap: Phase I up to $240,000 total: $140,000 Base + $100,000 Option; Phase II up to $2,000,000
CMMC: Level 2 self
ITAR in DSIP detail: true
Primary repo fit: Sigilix
Fit rating: **6.5 / 10 technical, 3.5 / 10 Arc & Anchor-only probability**

Why this fits:

- Sigilix reviews code, flags issues, and can be adapted toward refactoring and testing.
- The topic asks for AI-based legacy code analysis, refactoring, cybersecurity integration, and
  automated validation/testing.
- It is SBIR, not STTR.

Why it is hard:

- Theater Mission Planning Center software is a defense-specific classified-adjacent system.
- Phase II may become classified.
- We do not have TMPC evidence or legacy mission-planning software experience.
- It closes earlier than the DLA pre-release topics.

Chance estimate if Arc & Anchor builds the demo alone:

- Technical viability: **50-60%**
- Competitive Phase I proposal: **20-35%**
- Award odds: **10-20%**

Recommendation:

- Do not prioritize unless we intentionally want a Navy software-modernization proposal with higher
  classification and domain risk.

### 7. SF254-D1201: Integrated S&T Insight And Co-Investment Decision Support Platform

Status: Open
Open date: 2026-04-13
Close date: 2026-05-13
Program: SBIR
Phase path: Direct to Phase II / Phase II / Sequential Phase II
Funding cap: Direct-to-Phase-II up to $1,500,000
Primary repo fit: Predict Market Bot + Sigilix
Fit rating: **6 / 10 technical, 2 / 10 timing**

Why this fits:

- Predict Market Bot has decision support, risk scoring, signal aggregation, and forecasting ideas.
- Sigilix can provide workflow and evidence.

Why it is not practical:

- It closes on 2026-05-13.
- It is Direct-to-Phase-II.
- It expects validated product-mission fit with USSF/USAF stakeholders.

Recommendation:

- Do not pursue this round.
- Revisit if reissued and if we build an S&T insight product.

## STTR Exclusion

### DON26TZ01-NV008: Automated Software Test Generation And Augmentation For Improved Debloating

Status: Open
Program: STTR
Open date: 2026-05-06
Close date: 2026-06-03
Q&A close: 2026-05-20
Phase path: Phase I / Phase II / Sequential Phase II
Funding cap: Phase I up to $240,000 total: $140,000 Base + $100,000 Option; Phase II up to $2,000,000
CMMC: Level 2 self
ITAR in DSIP detail: false
Primary repo fit: Sigilix
Technical fit rating: **8.5 / 10**
Arc & Anchor-only pursuit rating: **0 / 10 because STTR requires a formal research institution**

Why it was attractive:

- It is the cleanest technical fit for Sigilix's code review, CI triage, retrieval, and test-generation
  roadmap.
- It is normal Phase I and no ITAR flag appeared in the DSIP detail.
- A strong Sigilix TestForge demo would be realistic.

Why it is not viable under the current constraint:

- STTR requires a qualifying research institution partner.
- The partner is not just a letter writer; it must perform funded R&D work and satisfy workshare.
- Arc & Anchor-only submission would not match the program structure.

Recommendation:

- Do not pursue this round unless we secure a university/nonprofit research institution partner quickly.
- Reuse the TestForge idea later for an SBIR topic or commercial Sigilix feature.

## Topics To Avoid For Now

### DAF26BZ01-DV005: Multimodal Scene Construction

Reason:

- Requires RF/EO/IR, geospatial scene generation, FLITES/Xpatch compatibility, and AI/ML synthetic
  data evidence.
- We only have a concept draft, not existing technical evidence.

### OSW26BZ02-DV004: Game-Theoretic AI For COA Generation And Wargaming

Reason:

- Requires mature computational game-theory prototype, approximate Nash equilibrium methods, expert
  planner benchmarks, and M&S integration.
- Predict Market Bot is not enough evidence.

### HR0011SB20254-12: Assessing Security Of Encrypted Messaging Applications

Reason:

- Direct-to-Phase-II.
- Requires secure messaging application evaluation, automated vulnerability discovery, and
  state-of-the-art comparisons.
- Sigilix security scanning is adjacent but not enough.

### DON26BZ01-NV003: High Clutter Virtual Objects For Modeling And Simulation

Reason:

- Requires OSG scene generation, radiometric EO/IR objects, weather-explicit clouds or debris fields.
- ARC3D is only a placeholder.

### DON26BZ01-NV015: Virtual Reality Model Walkthrough

Reason:

- Requires VR headset/model walkthrough capability.
- ARC3D is not implemented yet.

## Recommended Pursuit Order

This order assumes no formal research institution, defense prime, university lab, or funded partner.

1. **Primary:** `DLA26BZ02-NV006` with Sigilix RMF Preflight.
2. **Secondary:** `DLA26BZ02-NV005` with Sigilix CyberRange Agents.
3. **RubberFit path:** `DLA26BZ02-NV010` with RubberFit CapacityNet.
4. **Stretch:** `OSW26BZ02-DV003` with Sigilix SecureFlow.
5. **Lower-probability backup:** `DLA26BZ02-NV004` with Arc Mission Thread.
6. **Do not pursue solo:** `DON26TZ01-NV008` because it is STTR.

Recommended submission posture:

- Submit **one serious primary SBIR** if bandwidth is limited: `DLA26BZ02-NV006`.
- Submit **two** only if we can build two credible demos without weakening the primary: `DLA26BZ02-NV006`
  plus either `DLA26BZ02-NV005` or `DLA26BZ02-NV010`.
- Keep OSW Direct-to-Phase-II as a separate stretch only if the SecureFlow demo becomes strong enough
  to survive Phase-I-equivalent scrutiny.

## Immediate Actions

### For DLA26BZ02-NV006

- Adapt SecureFlow into RMF Preflight.
- Use OSCAL/NIST artifacts and synthetic RMF packages.
- Ask Q&A after 2026-05-27 whether R&D sandbox deployment can be simulated in Phase I.
- Build a small demo that ingests synthetic artifacts and emits gap findings, confidence, evidence
  links, and a human-attestation record.
- Frame Arc & Anchor as the builder/operator, with outside reviewers only as optional non-funded
  validators.

### For DLA26BZ02-NV005

- Build a defensive-only cyber lab with intentionally vulnerable services and strict tool allowlists.
- Show enumeration, evidence capture, vulnerability explanation, and human approval gates.
- Emphasize misuse prevention, audit logging, and non-exploit default behavior.

### For DLA26BZ02-NV010

- Build a RubberFit CapacityNet mock dataset and matcher.
- Ask Q&A whether educational/research institution partner letters are required or simply helpful.
- Keep it separate from Sigilix unless we decide RubberFit deserves its own proposal lane.

### For DON26TZ01-NV008

- Stop proposal work unless a formal research institution partner appears.
- Keep TestForge as an internal Sigilix feature idea because the technical fit is still excellent.

## Source Notes

The scan used the DSIP public topics API:

- `https://www.dodsbirsttr.mil/topics-app/`
- `https://www.dodsbirsttr.mil/topics/api/public/topics/search`
- `https://www.dodsbirsttr.mil/topics/api/public/topics/{topicId}/details`

Funding caps were verified against DSIP component instruction PDFs:

- DLA SBIR 26.BZ Release 2 instructions:
  `https://www.dodsbirsttr.mil/submissions/api/public/download?uploadId=1736714`
- SCO SBIR 26.BZ Direct-to-Phase-II Release 2 instructions:
  `https://www.dodsbirsttr.mil/submissions/api/public/download?uploadId=1736475`
- Navy SBIR 26.BZ Phase I Release 1 instructions:
  `https://www.dodsbirsttr.mil/submissions/api/public/download?uploadId=1738188`
- Navy STTR 26.TZ Release 1 instructions:
  `https://www.dodsbirsttr.mil/submissions/api/public/download?uploadId=1737883`
- DAF/Space Force SBIR 25.4 D2P2 Release 12 instructions:
  `https://www.dodsbirsttr.mil/submissions/api/public/download?uploadId=1733239`

Topic statuses and dates can change. Re-run the scan before making a final pursue/no-pursue decision.
