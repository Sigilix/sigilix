# DSIP Active Topic Fit Scan For Arc And Anchor Repositories

Date: 2026-05-10 America/Los_Angeles
Status: Working opportunity scan
Source: DSIP Topics app public API, active/pre-release topics
Scope scanned: 158 active or pre-release topics

## Executive Readout

If Arc and Anchor does not have access to a defense/security SME, the best move is to prioritize
**normal Phase I topics** where the Government expects feasibility work to be done during the award.
Direct-to-Phase-II topics can still be viable, but they require prior domain evidence and partner
credibility that is hard to manufacture quickly.

The strongest current repo-to-topic fits are:

1. **DON26TZ01-NV008: Automated Software Test Generation and Augmentation for Improved Debloating**
   - Best fit for Sigilix.
   - Normal Phase I.
   - No ITAR flag in DSIP detail.
   - Existing Sigilix code-review, CI triage, retrieval, security, and multi-agent review evidence maps
     directly.
2. **DLA26BZ02-NV006: AI-Assisted RMF Pre-Adjudication for Research, Development, and Rapid
   Prototyping Environments**
   - Strong fit for Sigilix SecureFlow.
   - Normal Phase I.
   - Still wants RMF/security knowledge, but Phase I can prove the approach instead of requiring full
     prior Direct-to-Phase-II evidence.
3. **DLA26BZ02-NV005: Strengthening Defensive Cybersecurity and Penetration Testing Through Agentic AI
   and Automation**
   - Strong fit for Sigilix's agentic/security direction.
   - Normal Phase I.
   - Needs careful cyber-safety scoping and a controlled lab demo.
4. **OSW26BZ02-DV003: Generative AI for Secure Workflow Automation and Compliance**
   - Strongest Direct-to-Phase-II Sigilix fit.
   - Higher credibility burden because it explicitly asks for prior government/classified/security process
     evidence.
5. **DLA26BZ02-NV010: Enhancing Tertiary Manufacturing Capacity Utilization with Secure Data Practices**
   - Best RubberFit manufacturing-operations fit.
   - Normal Phase I.
   - No ITAR flag in DSIP detail.

Bottom line:

> If we want the highest probability path without a defense SME, pursue `DON26TZ01-NV008` first and
> `DLA26BZ02-NV006` second. Keep `OSW26BZ02-DV003` as a stretch Direct-to-Phase-II opportunity only
> if we can build the SecureFlow demo and get at least one credible reviewer letter.

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

## Ranked Topic Shortlist

### 1. DON26TZ01-NV008: Automated Software Test Generation and Augmentation for Improved Debloating

Status: Open
Open date: 2026-05-06
Close date: 2026-06-03
Q&A close: 2026-05-20
Phase path: Phase I / Phase II / Sequential Phase II
CMMC: Level 2 self
ITAR in DSIP detail: false
Primary repo fit: Sigilix
Fit rating: **8.5 / 10**

Why this fits:

- The topic asks for automated multi-modal processing of code and DevOps artifacts to generate,
  enhance, expand, and augment software tests.
- Sigilix already ingests code, diffs, docs, CI logs, and repository context.
- Sigilix already has specialist reasoning, CI triage, security review, and structured findings.
- The Phase I task is concept/prototype work, not Direct-to-Phase-II proof.

Best product framing:

> Sigilix TestForge: a multi-agent test generation and augmentation system that ingests code,
> documentation, existing test suites, CI logs, and user input to produce executable tests and coverage
> evidence for safer software transformation and debloating.

Existing evidence to cite:

- multi-agent code review;
- retrieval over repo context;
- CI failure triage;
- structured findings;
- security and dependency evidence channels;
- production GitHub integration;
- passing test suite.

Phase I demo to build:

- choose one open-source repo or internal fixture;
- ingest README, source files, existing tests, and CI logs;
- generate missing unit tests;
- run the tests;
- produce coverage delta;
- produce a "debloat readiness" report that identifies tested vs untested behavior;
- show human refinement loop.

Main gaps:

- actual executable test generation is not built yet;
- debloating-specific validation needs a lightweight proof;
- need containerized packaging story for software factory environments.

Chance estimate if we build the demo:

- Technical viability: **75-85%**
- Competitive Phase I proposal: **55-70%**
- Award odds: **35-55%**

Recommendation: **Highest priority.**

### 2. DLA26BZ02-NV006: AI-Assisted RMF Pre-Adjudication For R&D Environments

Status: Pre-release
Open date: 2026-05-27
Close date: 2026-06-24
Q&A close: 2026-06-10
Phase path: Phase I / Phase II / Sequential Phase II
CMMC: Level 2 self
ITAR in DSIP detail: true
Primary repo fit: Sigilix and SecureFlow
Fit rating: **8 / 10**

Why this fits:

- The topic asks for AI-assisted, artifact-centric RMF pre-adjudication.
- Sigilix already does artifact review, structured comments, evidence injection, and human review.
- The SecureFlow OSW proposal draft already defines compliance, risk, audit, and policy-as-code
  patterns that can be adapted here.
- It is normal Phase I, so lack of prior defense SME evidence is less fatal than OSW Direct-to-Phase-II.

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

Chance estimate if we build demo and get a CIO/compliance reviewer:

- Technical viability: **70-80%**
- Competitive Phase I proposal: **50-65%**
- Award odds: **30-50%**

Recommendation: **Second priority.**

### 3. DLA26BZ02-NV005: Agentic AI For Defensive Cybersecurity And Penetration Testing

Status: Pre-release
Open date: 2026-05-27
Close date: 2026-06-24
Q&A close: 2026-06-10
Phase path: Phase I / Phase II / Sequential Phase II
CMMC: Level 2 self
ITAR in DSIP detail: true
Primary repo fit: Sigilix
Fit rating: **7.5 / 10**

Why this fits:

- The topic asks for an agentic AI framework for cybersecurity task automation.
- Sigilix already has agent orchestration, security specialists, evidence channels, and human oversight.
- Phase I only requires a foundational task prototype such as automated network enumeration and a
  researcher agent.

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
- may need a cybersecurity SME or consultant.

Chance estimate if we build a controlled lab demo:

- Technical viability: **65-75%**
- Competitive Phase I proposal: **45-60%**
- Award odds: **25-45%**

Recommendation: **Good, but riskier than RMF because of cyber-safety and tool depth.**

### 4. OSW26BZ02-DV003: Generative AI For Secure Workflow Automation And Compliance

Status: Pre-release
Open date: 2026-05-27
Close date: 2026-06-24
Q&A close: 2026-06-10
Phase path: Direct to Phase II / Phase II / Sequential Phase II
CMMC: Level 1
ITAR in DSIP detail: true
Primary repo fit: Sigilix
Fit rating: **7.5 / 10 technical, 5.5 / 10 proposal-risk-adjusted**

Why this fits:

- The topic asks for a secure enterprise GenAI platform for SCG, PPP, OPSEC, compliance, risk, and
  insider-threat workflows.
- Sigilix is already a production secure AI workflow system.
- The SecureFlow proposal draft maps this well.

Why it is risky:

- Direct-to-Phase-II requires Phase-I-equivalent evidence.
- The topic explicitly asks for classified/security process experience and government acumen.
- Without a defense/security SME, the team credibility section is exposed.

Recommendation:

- Keep as a stretch.
- Pursue only if we build the SecureFlow demo and get at least one credible CIO/compliance/security
  reviewer letter.

### 5. DLA26BZ02-NV010: Enhancing Tertiary Manufacturing Capacity Utilization With Secure Data Practices

Status: Pre-release
Open date: 2026-05-27
Close date: 2026-06-24
Q&A close: 2026-06-10
Phase path: Phase I / Phase II / Sequential Phase II
CMMC: Level 2 self
ITAR in DSIP detail: false
Primary repo fit: RubberFit
Fit rating: **7 / 10**

Why this fits:

- The topic asks for a secure AI-driven system to map manufacturing capabilities and capacity from
  tertiary sources to defense manufacturing demands.
- RubberFit already has manufacturing operations, inventory, procurement, suppliers, utilization, and
  optimization concepts.
- No ITAR flag in the topic detail lowers the initial burden.

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

Phase I demo to build:

- synthetic dataset of educational/research institution machines and capabilities;
- demand profile matcher;
- secure data exchange model;
- legal framework template;
- dashboard showing capacity, fit score, and engagement workflow.

Main gaps:

- RubberFit is focused on rubber fabrication, not broad institutional manufacturing networks.
- Need manufacturing-partner discovery or at least credible synthetic demos.

Chance estimate:

- Technical viability: **65-75%**
- Competitive Phase I proposal: **45-60%**
- Award odds: **25-45%**

Recommendation: **Best RubberFit opportunity.**

### 6. DLA26BZ02-NV004: Enterprise Digital Thread With Mission-Aware Decision Intelligence

Status: Pre-release
Open date: 2026-05-27
Close date: 2026-06-24
Q&A close: 2026-06-10
Phase path: Phase I / Phase II / Sequential Phase II
CMMC: Level 2 self
ITAR in DSIP detail: true
Primary repo fit: RubberFit + Sigilix + Predict Market Bot
Fit rating: **6.5 / 10**

Why this fits:

- The topic asks for federated data integration, mission dependency modeling, predictive/prescriptive
  analytics, and decision dashboards.
- RubberFit has operations data models and dashboards.
- Predict Market Bot has forecasting/risk primitives.
- Sigilix has AI workflow and evidence patterns.

Why it is hard:

- It references DLA enterprise systems, IL4/IL5, FedRAMP High, MuleSoft, ServiceNow, Celonis, Vertex AI,
  Oracle Cloud, and OT environments.
- This is an enterprise integration topic, not just a software product topic.

Recommendation:

- Possible with a strong enterprise integration partner.
- Not first choice without one.

### 7. DON26BZ01-NV013: AI-Assisted Modernization And Optimization Of TMPC Software

Status: Open
Open date: 2026-05-06
Close date: 2026-06-03
Q&A close: 2026-05-20
Phase path: Phase I / Phase II / Sequential Phase II
CMMC: Level 2 self
ITAR in DSIP detail: true
Primary repo fit: Sigilix
Fit rating: **6.5 / 10**

Why this fits:

- Sigilix reviews code, flags issues, and can be adapted toward refactoring and testing.
- The topic asks for AI-based legacy code analysis, refactoring, cybersecurity integration, and
  automated validation/testing.

Why it is hard:

- Theater Mission Planning Center software is a defense-specific classified-adjacent system.
- Phase II may become classified.
- We do not have TMPC evidence or legacy mission-planning software experience.

Recommendation:

- Lower priority than Navy test generation because `DON26TZ01-NV008` is more generic and better
  aligned to existing Sigilix.

### 8. SF254-D1201: Integrated S&T Insight And Co-Investment Decision Support Platform

Status: Open
Open date: 2026-04-13
Close date: 2026-05-13
Phase path: Direct to Phase II / Phase II / Sequential Phase II
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

1. **Primary:** `DON26TZ01-NV008` with Sigilix TestForge.
2. **Secondary:** `DLA26BZ02-NV006` with Sigilix RMF Preflight.
3. **Tertiary:** `DLA26BZ02-NV005` with Sigilix CyberRange Agents.
4. **Stretch:** `OSW26BZ02-DV003` with Sigilix SecureFlow.
5. **RubberFit path:** `DLA26BZ02-NV010` with RubberFit CapacityNet.

## Immediate Actions

### For DON26TZ01-NV008

- Build a two-day demo that generates and runs tests from code + README.
- Add a "debloat readiness" report.
- Draft a Phase I proposal around TestForge.
- Ask Q&A before 2026-05-20 whether open-source/demo repos are acceptable as Phase I fixtures.

### For DLA26BZ02-NV006

- Adapt SecureFlow into RMF Preflight.
- Use OSCAL/NIST artifacts and synthetic RMF packages.
- Ask Q&A after 2026-05-27 whether R&D sandbox deployment can be simulated in Phase I.

### For DLA26BZ02-NV010

- Build a RubberFit CapacityNet mock dataset and matcher.
- Ask Q&A whether educational/research institution partner letters are required or simply helpful.

## Source Notes

The scan used the DSIP public topics API:

- `https://www.dodsbirsttr.mil/topics-app/`
- `https://www.dodsbirsttr.mil/topics/api/public/topics/search`
- `https://www.dodsbirsttr.mil/topics/api/public/topics/{topicId}/details`

Topic statuses and dates can change. Re-run the scan before making a final pursue/no-pursue decision.
