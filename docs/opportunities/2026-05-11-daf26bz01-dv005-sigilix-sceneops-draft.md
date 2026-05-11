# DAF26BZ01-DV005 Draft: Sigilix SceneOps for Multimodal Scene Construction

Date: 2026-05-11
Status: Draft proposal artifact; superseded if pursuing OSW26BZ02-DV003
Source topic: `DAF26BZ01-DV005: AI Framework for Multimodal Scene Construction and Data Generation`

> Note: This document covers the earlier scene-generation opportunity. The corrected, stronger-fit
> opportunity is `OSW26BZ02-DV003: Generative AI for Secure Workflow Automation and Compliance`.
> Use `2026-05-10-osw26bz02-dv003-sigilix-secureflow-draft.md` as the primary proposal draft if
> pursuing the screenshot topic.

## Executive Thesis

Sigilix should not be positioned as an already-complete RF/EO/IR scene generator. That would be
overstated. The credible and defensible positioning is stronger:

> Sigilix is an already-operational production LLM orchestration framework for technical reasoning,
> retrieval, deterministic evidence injection, multi-agent synthesis, asynchronous execution, and
> auditable automation. For DAF26BZ01-DV005, the proposed work adapts this production AI framework
> into a domain-specific scene-construction control plane that plans, coordinates, validates, and
> documents geo-specific multimodal scene generation workflows.

This gives the proposal a real advantage over teams that are only proposing an LLM wrapper or a
greenfield agent system. Sigilix already proves the hard software-engineering layer: production
webhooks, queues, model calls, structured outputs, deterministic evidence, provenance, retry/state
handling, repository-specific configuration, and human review loops. The proposed Phase II work
would focus on domain adaptation: geospatial ingestion, a sensor-independent scene representation,
RF/EO/IR backend adapters, validation against measured/authoritative data, and demonstration
workflows.

The strongest product name for this adaptation is **Sigilix SceneOps**.

## Submission Posture Recommendation

The viable submission posture is **not** "Sigilix alone already satisfies the topic." It does not.
The viable posture is one of the following:

1. **Best posture: prime with a scene-generation/RF/EO/IR partner.** Sigilix is the production AI
   orchestration, evidence, assurance, provenance, and workflow layer. The partner supplies prior
   Phase-I-equivalent scene-generation evidence and simulator-domain credibility.
2. **Acceptable posture: Sigilix as focused subcontractor.** Sigilix contributes agentic workflow,
   validation, provenance, software assurance, controlled-data gating, and proposal/evaluation
   automation around another team's scene-generation backend.
3. **Risky posture: Sigilix-alone prime.** This should only be attempted if we can create or cite a
   credible pre-submission ROI-to-background-scene artifact and explain that Phase II adds the
   simulator-specific RF/EO/IR adapters. Without that artifact, the Direct-to-Phase-II eligibility
   risk is high.

The proposal should be direct about this:

> Sigilix reduces AI-framework and software-execution risk, but the Phase II technical plan must add
> or partner for geospatial scene construction, RF/EO/IR physics, and simulator compatibility.

## Separate Repository / Product-Line Strategy

The strongest implementation posture is a **separate repository and product line**:

```text
sigilix                 -> production AI code-review and assurance product
sigilix-sceneops        -> defense/geospatial scene-construction control plane
```

This should still use the Sigilix name, but not live inside the main Sigilix code-review repo. The
right framing is:

> Sigilix SceneOps is a domain-specific extension of the Sigilix AI orchestration architecture, built
> as a separate repository and deployment boundary for geospatial, RF, EO/IR, controlled-data, and
> simulator-integration workflows.

### Why separate it

Separating `sigilix-sceneops` from the main Sigilix repo helps the proposal in several ways.

**1. Compliance boundary.**

The DAF26BZ01-DV005 topic explicitly flags ITAR/EAR risk and CMMC Level 2 self-assessment. The core
Sigilix repo is a commercial GitHub/Linear code-review product. SceneOps will need different
controls:

- controlled-data handling;
- export-control review;
- U.S.-person / foreign-national participation tracking;
- CMMC-oriented evidence;
- local/on-prem model routing;
- government customer data boundaries;
- simulator-specific access controls.

A separate repo lets the proposal say we are not bolting controlled-data workflows onto a general
commercial SaaS surface. We are creating a dedicated controlled-data-ready product boundary.

**2. Heavy dependency boundary.**

Core Sigilix is a Cloudflare Worker. SceneOps needs native/GPU tools:

- GDAL;
- Rasterio;
- PDAL;
- OSMnx;
- OpenUSD;
- Blender/BlenderProc;
- Mitsuba;
- Sionna RT;
- libRadtran/Py6S;
- MLflow;
- DVC/lakeFS.

Those should not enter the Worker repo. A separate repo can own container images, Python
environments, GPU job runners, geospatial pipelines, and large artifact schemas while core Sigilix
stays small, fast, and production-safe.

**3. Licensing boundary.**

Several useful demo tools have GPL or mixed licensing concerns. A separate repo can make component
boundaries explicit:

- permissive core orchestration code;
- external CLI/container calls for GPL tools;
- generated artifacts tracked separately;
- SBOM and license review per container.

That matters for commercialization and government transition. It is easier to explain than mixing
GPL-adjacent geospatial/rendering pipelines into the existing Sigilix product repo.

**4. Data and artifact boundary.**

SceneOps will produce large and potentially sensitive artifacts:

- DEM/DSM clips;
- land-cover rasters;
- OSM/vector layers;
- point-cloud derivatives;
- OpenUSD/glTF/3D Tiles scenes;
- rendered images;
- RF maps;
- ground-truth labels;
- MLflow/DVC/lakeFS run records.

These should not share assumptions with a code-review repo. A separate repo can define object-storage
layout, STAC catalogs, data-retention rules, and controlled export rules from day one.

**5. Proposal credibility.**

A separate `sigilix-sceneops` repo makes the Phase II plan look like a deliberate product line, not
a one-off folder in a code-review tool. The proposal can claim:

- the existing Sigilix repo proves the production AI orchestration substrate;
- the new SceneOps repo is the dedicated Phase II prototype and transition vehicle;
- shared ideas flow from Sigilix, but scene-generation work has its own governance and compliance
  boundary.

### Suggested naming

Best names:

- **Sigilix SceneOps**: strongest for the proposal; implies operations/control plane.
- **Sigilix GeoScene**: clearer geospatial signal, less tied to operations.
- **Sigilix Multimodal SceneOps**: verbose but very aligned to the topic.
- **Sigilix Synthetic SceneOps**: emphasizes synthetic data, but less broad.

Recommended:

```text
Product name: Sigilix SceneOps
Repository: arc-and-anchor/sigilix-sceneops
Package namespace: @arc-and-anchor/sigilix-sceneops or sigilix-sceneops
```

Avoid names like `sigilix-defense` or `sigilix-dod` in the repo. They narrow the commercial story
and make export-control questions more prominent than necessary. The product can serve defense first
while keeping a dual-use geospatial/simulation story.

### Repository structure

Proposed v1 layout:

```text
sigilix-sceneops/
  docs/
    opportunity/
    architecture/
    compliance/
    adapters/
  sceneir/
    schema/
    examples/
  pipelines/
    ingest-geospatial/
    build-sceneir/
    export-usd/
    export-3dtiles/
    render-eo/
    render-rf/
    validate/
  workers/
    api/
    job-runner/
    dashboard/
  containers/
    gdal-rasterio/
    pdal/
    blenderproc/
    sionna-rt/
    radiative-transfer/
  examples/
    public-roi-demo/
  tests/
    fixtures/
```

The main Sigilix repo should only reference SceneOps at the documentation/product level unless and
until shared packages are intentionally extracted.

### Shared components without tight coupling

Do not import the main Sigilix Worker directly into SceneOps at first. Instead, copy or reimplement
small patterns where needed, then extract shared packages later if both repos stabilize.

Possible future shared packages:

- `@arc-and-anchor/sigilix-agent-core`: structured model calls, JSON parsing, retry/fallback policy.
- `@arc-and-anchor/sigilix-evidence`: evidence records, provenance rendering, report schemas.
- `@arc-and-anchor/sigilix-policy`: sensitive-data gates, model-routing policies.
- `@arc-and-anchor/sigilix-status`: job/run state and status projection types.

Do not extract these prematurely. The first Phase II objective is credible delivery, not internal
platform elegance.

### Proposal language for separate repo

Use:

> Sigilix SceneOps will be developed as a dedicated sibling repository to the existing Sigilix
> code-review product. This preserves the proven Sigilix AI orchestration architecture while creating
> a separate compliance, data, dependency, and deployment boundary for geospatial scene construction,
> RF/EO/IR backends, controlled-data workflows, and simulator adapters.

Use:

> The existing Sigilix repository is evidence of production readiness for multi-agent AI workflow
> orchestration. The SceneOps repository is the Phase II prototype vehicle that adapts those
> operational patterns to ROI ingestion, SceneIR generation, open-source geospatial/RF/EO
> processing, validation, and transition-adapter development.

Avoid:

> "We will add scene generation to the existing Sigilix GitHub review bot."

That makes the work sound like a feature extension to a code-review product. It is better framed as
a new domain product using Sigilix's proven architecture.

## Core Proposal Positioning

### What Sigilix can claim today

Sigilix currently supports:

- Production multi-agent LLM orchestration for technical review.
- Parallel specialist review and synthesis.
- Retrieval over indexed repositories and documents.
- Deterministic evidence channels for security, AST rules, dependency vulnerability data, and SARIF.
- Structured JSON output parsing and validation.
- Durable asynchronous execution through Cloudflare queues and Durable Objects.
- Human-in-the-loop workflows on GitHub and Linear.
- Per-repo configuration through `sigilix.json`.
- Provenance markers, stale review detection, and review memory.
- Sensitive-repo gates that can block content from model paths.

These are directly relevant to the "AI framework" part of the topic. They are not yet scene
generation, but they are a production substrate for:

- breaking a complex technical objective into specialist reasoning tasks;
- retrieving authoritative context;
- injecting deterministic evidence;
- producing auditable structured outputs;
- coordinating long-running jobs;
- surfacing gaps, risk, and required human approval.

### What Sigilix cannot claim today

Sigilix does not currently:

- ingest geographic coordinates and build a physical scene;
- ingest DEMs, land cover, OSM, LiDAR, seasonal/weather data, or measured radiometric databases;
- produce RF, EO, IR, SAR, or hyperspectral synthetic data;
- export to FLITES, Xpatch, AFSIM, SSGM, or other government simulator formats;
- model electromagnetic propagation, thermal signatures, atmospheric effects, or sensor calibration;
- demonstrate AI/ML performance improvement for geolocation, ATR, scene understanding, or autonomous
  agent evaluation.

The proposal should explicitly avoid saying those capabilities already exist.

### The defensible claim

Use this formulation:

> We have already built and deployed the LLM-agent orchestration layer required for an AI framework:
> multi-agent tasking, retrieval, deterministic evidence injection, structured outputs, provenance,
> long-running asynchronous execution, and human-review loops. Phase II adapts that operational
> framework to multimodal scene construction by adding geospatial ingestion, a sensor-independent
> SceneIR, RF/EO/IR simulator adapters, validation loops, and controlled-data governance.

## Solicitation Fit

The topic asks for a capability that:

- generates geo-specific, sensor-independent scenes;
- supports multimodal RF and EO/IR synthetic data generation;
- uses geospatial information, time-of-day, seasonal data, measured databases, and land cover data;
- overcomes limitations in existing models and radiometric data;
- maintains spatial and temporal consistency across modalities;
- supports dynamic scenes for autonomous agents;
- supports standardized scene formats compatible with RF and EO/IR tools such as Xpatch and FLITES;
- improves fidelity over time as real-world measurements become available;
- demonstrates AI/ML performance improvements on geolocation, ATR, scene understanding, and related
  tasks;
- plans transition to DoD users and Phase III commercialization.

The Sigilix fit is strongest if we define the proposed system as a control plane with modular
backends:

```text
Region of interest + mission intent
        |
        v
Sigilix SceneOps planner
        |
        v
SceneIR: sensor-independent scene representation
        |
        +--> Geospatial data build pipeline
        +--> RF simulation adapter
        +--> EO/IR rendering adapter
        +--> Ground-truth label generator
        +--> Validation and evidence ledger
        +--> Human review and compliance gates
```

Sigilix owns the orchestration, reasoning, evidence, provenance, and review loop. Specialized engines
own physics, rendering, geospatial processing, and simulator export.

## Direct-to-Phase-II Reality

The topic is Direct-to-Phase-II. That means the proposal must convince the government that Phase-I
equivalent feasibility already exists.

The solicitation's Phase I expectation is not merely "we have an LLM." It expects prior ability to
automatically build background scenes for either RF or EO/IR simulation tools and evidence that such
scenes can support synthetic data generation or autonomous-system training/evaluation.

Sigilix alone does not satisfy that expectation. The proposal should therefore separate:

- **Existing capability:** production LLM-agent orchestration, evidence synthesis, and auditability.
- **Phase-I-equivalent bridge:** a small pre-award feasibility artifact using open-source tools to
  show an ROI-to-scene-manifest path.
- **Phase II build:** full prototype software, adapter hardening, validation, and demonstration.

If time permits before submission, build a small non-sensitive feasibility artifact:

1. Input one public ROI.
2. Ingest public elevation, land cover, and OSM building/road data.
3. Generate a `SceneIR` manifest.
4. Produce a visual 3D preview.
5. Produce a simple RF propagation preview using an open-source RF ray-tracing backend.
6. Produce a Sigilix-generated evidence/readiness report mapping scene assets to sources,
   assumptions, missing measured data, and Phase II tasks.

This does not need to be FLITES/Xpatch compatible yet. It is a credibility bridge showing the path
from Sigilix's production AI framework to scene-construction automation.

Minimum pre-submission bridge package:

- one `SceneIR` JSON example for a real public ROI;
- one screenshot or rendered preview of the terrain/building scene;
- one evidence report generated by Sigilix or a Sigilix-style prompt;
- one adapter-gap table showing how the open demo backend differs from FLITES and Xpatch;
- one paragraph stating exactly which partner, future work package, or customer interface closes
  each gap.

If that cannot be created before submission, the proposal should avoid prime-contractor language and
instead position Sigilix as a technology accelerator or subcontractor layer.

## How This Helps Land Phase II

The open-source implementation path is not just an engineering convenience. It is the proposal
strategy. It gives reviewers concrete proof against the criteria that usually decide a Direct-to-
Phase-II selection.

Official DoW SBIR/STTR guidance says proposals are evaluated on factors in descending importance:

1. soundness, technical merit, innovation, and progress toward the topic solution;
2. qualifications of principal/key investigators, staff, consultants, and their ability to
   commercialize;
3. potential Government or private-sector application and commercialization benefit.

The same guidance also states that reviewers base conclusions only on information contained in the
proposal. That matters here. A reviewer will not infer that Sigilix can become a scene-generation
framework just because it is a production LLM system. The proposal needs explicit artifacts that make
the leap visible.

### Why the open-source stack improves Phase II odds

The open-source implementation path helps us win because it converts the proposal from:

> "We have an LLM agent product and could adapt it."

into:

> "We have a production AI orchestration product, and we have mapped it to a concrete scene-
> construction pipeline using known geospatial, RF, EO-style rendering, provenance, and validation
> components. We know what works today, what remains a Phase II adapter task, and how each component
> will be validated."

That is the difference between a speculative AI wrapper and a credible Phase II prototype plan.

### Phase II evaluation factor 1: technical merit and innovation

Reviewer concern:

- "Is this a real technical approach, or just an LLM wrapper around a hard physics problem?"
- "Can the team actually ingest real geospatial data?"
- "Can one scene representation support RF and EO/IR paths?"
- "Can the approach make progress without immediate access to FLITES, Xpatch, or classified
  databases?"

How the proposed implementation answers:

- **GDAL/Rasterio/PDAL/OSMnx** prove the approach starts with real geospatial ingestion, not text
  prompting.
- **SceneIR + OpenUSD** create a concrete sensor-independent representation rather than one-off
  exports.
- **3D Tiles/CesiumJS** give reviewers a visual, inspectable demonstration of geo-specific scene
  construction.
- **BlenderProc/Mitsuba/Py6S/libRadtran** show a credible EO/IR-adjacent path for imagery, labels,
  and atmospheric/radiometric assumptions, while clearly avoiding a false FLITES claim.
- **Sionna RT + SPLAT** show a credible RF-adjacent path for radio propagation, while clearly
  avoiding a false Xpatch claim.
- **STAC/DVC/lakeFS/MLflow/Great Expectations** show that the output is reproducible, validated,
  and traceable.
- **Sigilix** ties these together as a production control plane: job dispatch, evidence synthesis,
  specialist review, status, and human approvals.

Specific proposal evidence to include:

- a diagram showing `ROI -> geospatial ingestion -> SceneIR -> OpenUSD -> EO/RF demo backends ->
  validation -> Sigilix report`;
- a sample `SceneIR` manifest;
- a source/provenance table for one ROI;
- a rendered 3D preview screenshot;
- a mock or real RF propagation output;
- a mock or real labeled EO-style output;
- a table showing exactly what FLITES/Xpatch compatibility requires beyond the open demo backends.

Why this lands better:

- It shows technical merit without pretending the prototype is complete.
- It reduces dependency on government-furnished data for the first demonstration.
- It gives the reviewer concrete milestones they can believe in.
- It turns the hardest weakness, "Sigilix is not a scene generator yet," into a managed Phase II
  work plan.

### Phase II evaluation factor 2: team qualifications

Reviewer concern:

- "Does this team have the right skills for geospatial, RF, EO/IR, synthetic data, controlled data,
  and software delivery?"
- "If Sigilix is the only prior product, where is the domain depth?"

How the proposed implementation answers:

- Sigilix demonstrates production AI orchestration, software assurance, async cloud execution, and
  evidence handling.
- The open-source implementation plan shows the team understands the domain toolchain well enough to
  decompose it into real components.
- The partner/subcontractor posture is explicit: if Arc & Anchor lacks RF/EO/IR physics depth, the
  proposal should add named consultants or partners for:
  - RF propagation and Xpatch-style scattering;
  - EO/IR radiometry and FLITES integration;
  - geospatial data engineering;
  - CMMC/export-control compliance.

Specific proposal evidence to include:

- a "who owns what" table:

| Workstream | Owner Needed | Evidence in Proposal |
|---|---|---|
| Sigilix orchestration | Arc & Anchor | Production Sigilix repo, tests, deployed workflow |
| Geospatial ingestion | Arc & Anchor or partner | GDAL/Rasterio/PDAL demo plan and prior GIS experience |
| RF backend | RF partner/consultant | Sionna/SPLAT prototype plan plus Xpatch gap closure |
| EO/IR backend | EO/IR partner/consultant | BlenderProc/Mitsuba/Py6S/libRadtran plan plus FLITES gap closure |
| Data governance | Arc & Anchor + compliance advisor | CMMC Level 2 plan, controlled-data gates |
| AI/ML evaluation | Arc & Anchor or ML partner | MLflow experiment plan and baseline/synthetic comparison |

Why this lands better:

- It does not ask reviewers to believe one software team magically covers every domain.
- It shows the small business can manage and integrate a Phase II effort.
- It frames partners as risk reduction, not weakness.

### Phase II evaluation factor 3: commercialization and transition

Reviewer concern:

- "Is this only a one-off demo, or could it transition?"
- "Does it help DoD users and have broader commercial relevance?"
- "What survives if FLITES/Xpatch integration takes longer than expected?"

How the proposed implementation answers:

- `SceneIR` is the productizable interface: one control plane can target multiple simulators.
- OpenUSD/3D Tiles/glTF create commercial dual-use paths for digital twins, robotics simulation,
  infrastructure inspection, emergency planning, insurance, telecom RF planning, and autonomy data.
- Sionna RT and Cesium-style visualization support commercial RF/digital-twin demos without waiting
  for controlled government tools.
- STAC/DVC/lakeFS/MLflow evidence creates a repeatable data-product workflow, not just screenshots.
- Sigilix already has a commercializable AI workflow product foundation.

Specific proposal evidence to include:

- Phase III transition pathways:
  - DoD simulator integration;
  - defense autonomy synthetic data;
  - telecom/radio planning;
  - digital twin validation;
  - geospatial AI dataset generation;
  - commercial remote-sensing data products.
- A product architecture showing open backend support first and government simulator adapters second.
- A licensing/compliance table for open-source components.

Why this lands better:

- It shows the Phase II prototype has value even before classified data or simulator access.
- It gives reviewers a path to Government and private-sector commercialization.
- It aligns with SBIR's preference for commercial potential rather than one-off contract labor.

### D2P2 feasibility documentation

Direct-to-Phase-II proposals need evidence that Phase-I-equivalent feasibility has already been met
through non-SBIR/STTR work. For this topic, the weak point is the Phase I expectation around automatic
background-scene construction for RF or EO/IR simulation tools.

The open-source bridge does not fully satisfy that by itself unless we actually build and attach the
artifact. But it can materially improve the submission if we include a feasibility appendix:

| Feasibility Claim | Evidence to Attach | Strength |
|---|---|---|
| Sigilix production AI orchestration exists | Deployed architecture, test count, PR review workflows, queue/DO design | Strong |
| ROI-to-scene planning is feasible | Sigilix-generated scene plan for one public ROI | Medium |
| Public geospatial scene assembly is feasible | GDAL/Rasterio/OSMnx/OSM2World output and screenshot | Medium to strong if built |
| Sensor-independent representation is feasible | `SceneIR` manifest and OpenUSD/glTF export | Medium to strong if built |
| EO-style synthetic labels are feasible | BlenderProc output with segmentation/depth/labels | Medium if built |
| RF exploratory output is feasible | Sionna RT/SPLAT output from same ROI | Medium if built |
| FLITES/Xpatch path is understood | Adapter-gap report and partner plan | Medium, stronger with partner letter |
| AI/ML utility can be evaluated | MLflow baseline/synthetic experiment design | Medium; strong only after results |

Minimum package that should be attached or referenced:

- **Appendix A: Existing Sigilix Capability.** One page showing production architecture and proof of
  deployed multi-agent LLM orchestration.
- **Appendix B: SceneOps Feasibility Artifact.** ROI, source data, `SceneIR`, visual preview, and
  evidence report.
- **Appendix C: Open-Source Implementation Plan.** Toolchain with licenses, roles, and container/job
  boundaries.
- **Appendix D: FLITES/Xpatch Adapter Gap Closure.** What the open demo proves, what it does not
  prove, and how Phase II closes it.
- **Appendix E: Transition/Commercialization Path.** DoD and commercial applications.

### Why this is better than a competitor with no implementation

Against a competitor with only a written concept, this plan has advantages:

- production AI orchestration already exists;
- the geospatial/RF/EO-style prototype path is concrete and buildable with known tools;
- the proposal can show real artifacts instead of only architecture diagrams;
- risk is decomposed by backend and adapter;
- public-data demos avoid waiting for government-furnished data;
- provenance and validation are designed in from day one;
- controlled-data handling is treated as architecture, not an afterthought.

Against a competitor that already has RF/EO/IR simulators, Sigilix alone is weaker. The way to beat
or compete with that team is not to claim simulator superiority. It is to claim:

- faster AI-assisted scene planning;
- better evidence/provenance;
- better multimodal consistency tracking;
- better human review and approval loops;
- better extensibility across backends;
- stronger software assurance and delivery discipline;
- a clearer path from prototype to repeatable scene-generation operations.

### Concrete win themes

Use these as proposal headings or repeated themes:

1. **Operational AI, not prototype AI.** Sigilix already runs multi-agent LLM workflows in production.
2. **Sensor-independent by design.** `SceneIR` decouples geospatial scene construction from any
   single RF or EO/IR simulator.
3. **Open demo now, government adapters next.** Open-source backends prove the pipeline while
   FLITES/Xpatch adapters mature with transition partners.
4. **Evidence-first scene generation.** Every scene asset, material assumption, label, and output is
   traceable.
5. **Controlled-data aware.** Public-data and ITAR/EAR-sensitive workflows are separated from day
   one.
6. **Transition beyond one tool.** The same framework can support DoD simulation, telecom RF
   planning, digital twins, autonomy datasets, and remote-sensing data products.

### Proposal language that directly supports selection

Use:

> The proposed Phase II effort is structured to produce reviewer-verifiable progress early. Within
> the first technical milestone, SceneOps will ingest a public ROI, construct normalized terrain,
> land-cover, and structure layers using open geospatial tools, generate a sensor-independent
> SceneIR manifest, export an OpenUSD/3D Tiles preview, and produce a Sigilix evidence report. This
> milestone de-risks the core scene-construction workflow before simulator-specific FLITES and Xpatch
> adapters are completed.

Use:

> The open-source backends are not substitutes for FLITES or Xpatch. They are controlled
> demonstration and validation backends that allow the team to prove geo-specific scene assembly,
> cross-modal consistency, provenance, and synthetic-label generation while simulator-specific
> adapter details are coordinated with transition partners.

Use:

> Sigilix's production architecture directly supports Phase II execution risk reduction: it already
> provides queue-backed long-running jobs, structured model outputs, retrieval, deterministic
> evidence injection, provenance markers, status tracking, and human review loops. SceneOps extends
> those operational primitives to scene-generation tasks and external geospatial/RF/EO processing
> jobs.

Avoid:

> "The open-source stack makes us FLITES/Xpatch compatible."

Use instead:

> "The open-source stack establishes an unclassified, reproducible demonstration path and produces
> intermediate artifacts that will be mapped into FLITES/Xpatch-compatible adapters during Phase II."

## Proposed System: Sigilix SceneOps

### Capability 1: Scene Construction Planner

The planner converts mission intent into a structured work plan.

Input:

- coordinates or named region;
- ROI boundary;
- time of day;
- season;
- weather/atmospheric scenario;
- desired modalities: RF, EO, IR, SAR, visible, multispectral;
- target tasks: geolocation, ATR, scene understanding, autonomous navigation;
- desired fidelity/resolution;
- allowed data sources and controlled-data policy.

Output:

- required data sources;
- terrain and surface requirements;
- land cover and vegetation requirements;
- urban structure requirements;
- material and radiometric assumptions;
- sensor-view requirements;
- simulator export targets;
- known gaps;
- validation plan;
- human approvals required.

This is where Sigilix's existing multi-agent pattern fits naturally. The current code-review
specialists become domain specialists:

- geospatial specialist;
- RF propagation specialist;
- EO/IR rendering specialist;
- validation/evaluation specialist;
- compliance/export-control specialist;
- synthesizer.

### Capability 2: SceneIR

`SceneIR` is the central interface. It should be sensor-independent and backend-neutral.

Minimum v1 fields:

```json
{
  "schemaVersion": "sceneir.v0",
  "sceneId": "string",
  "roi": {
    "type": "bbox|polygon|point-radius",
    "crs": "EPSG:4326",
    "coordinates": []
  },
  "time": {
    "timestamp": "ISO-8601",
    "season": "winter|spring|summer|fall",
    "sun": {
      "azimuthDeg": 0,
      "elevationDeg": 0
    }
  },
  "terrain": {
    "source": "USGS 3DEP|SRTM|other",
    "resolutionMeters": 1,
    "crs": "string",
    "assetUri": "string",
    "provenance": []
  },
  "landCover": {
    "source": "NLCD|ESA WorldCover|other",
    "classes": [],
    "resolutionMeters": 10,
    "provenance": []
  },
  "features": {
    "buildings": [],
    "roads": [],
    "vegetation": [],
    "water": [],
    "other": []
  },
  "materials": {
    "rf": [],
    "eo": [],
    "ir": []
  },
  "atmosphere": {
    "weatherSource": "string",
    "model": "6S|libRadtran|placeholder",
    "parameters": {}
  },
  "sensors": [
    {
      "id": "sensor-1",
      "modality": "RF|EO|IR",
      "pose": {},
      "fov": {},
      "resolution": {},
      "calibration": {}
    }
  ],
  "exports": {
    "usd": "string",
    "gltf": "string",
    "tiles3d": "string",
    "rfAdapter": "string",
    "eoIrAdapter": "string"
  },
  "groundTruth": {
    "semanticLabels": "string",
    "instanceLabels": "string",
    "depth": "string",
    "occlusion": "string",
    "sensorPose": "string"
  },
  "validation": {
    "checks": [],
    "knownGaps": [],
    "confidence": {}
  }
}
```

This is not a final standard. It is a Phase II working contract that lets the team build adapters
incrementally without coupling Sigilix to one renderer or simulator.

### Capability 3: Data Source Registry

Sigilix should maintain a source registry for each scene build:

- source name;
- source type;
- access method;
- license or usage constraints;
- temporal coverage;
- spatial coverage;
- resolution;
- confidence;
- transformation steps;
- derived assets;
- validation checks;
- controlled-data classification.

This is where Sigilix's evidence channels matter. The system should not merely assemble data. It
should explain what was used, what was missing, and how much confidence the generated scene deserves.

### Capability 4: Simulator Adapter Layer

Phase II should define a backend adapter interface:

```text
SceneIR -> Adapter -> simulator-specific scene package
```

Candidate adapter targets:

- open demo backend: OpenUSD/glTF/3D Tiles;
- EO/IR exploratory backend: Mitsuba 3, Blender/Cycles, Py6S/libRadtran-assisted atmospheric
  parameterization;
- RF exploratory backend: Sionna RT;
- government transition backend: FLITES-compatible scene package;
- government transition backend: Xpatch-compatible scene package.

The proposal should avoid promising immediate direct FLITES/Xpatch compatibility unless transition
partners provide interface documentation and test environments. The defensible promise is:

> Phase II will define and implement adapter contracts, demonstrate open backend exports, and
> integrate with FLITES/Xpatch-compatible formats as documentation, access, and transition partners
> permit.

### Capability 5: Validation and Measurement Assimilation

The topic emphasizes improving scene fidelity as real-world measurements become available. Sigilix
can own the feedback loop:

1. Record generated scene assumptions.
2. Compare scene outputs against measured or authoritative data.
3. Identify mismatch by modality and feature type.
4. Propose updates to materials, surface classes, atmospheric parameters, or geometry.
5. Track the evidence trail.
6. Require human approval for controlled or high-impact changes.

This maps well to existing Sigilix review-memory and provenance concepts.

## Open-Source Toolchain for a Phase-II Demo

The following tools can support a credible public-data demo. None of them alone satisfies the whole
topic. Together, they provide a practical prototype stack around Sigilix.

Implementation boundary:

- Sigilix's Cloudflare Worker should remain the **control plane**: authentication, job dispatch,
  state, evidence, model reasoning, review, and reporting.
- Heavy geospatial, rendering, RF, and GPU workloads should run in **containerized workers or
  external job runners**. The Worker should submit jobs, track status, validate outputs, and write
  the evidence ledger.
- Large scene assets should live in object storage with metadata tracked through STAC, DVC/lakeFS, or
  equivalent provenance tooling.

| Layer | Tool | Role in Demo | Why It Helps | Caveats |
|---|---|---|---|---|
| Geospatial ingestion | GDAL/OGR | Read/write GeoTIFF, GeoPackage, shapefiles, OSM PBF, COG, DEMs, STAC-related assets | Industry-standard open-source raster/vector translation layer | Native dependency complexity; use as external tool or containerized worker |
| Raster processing | Rasterio | Python API over GDAL for DEM/land-cover raster clipping, reprojection, and array extraction | Fast path to implement ROI raster workflows | Python runtime separate from current Worker; use job container or external service |
| Point clouds | PDAL | LiDAR/LAZ processing, filtering, reprojection, ground classification support | Useful for high-fidelity terrain/building prototypes | Dataset availability varies; point-cloud processing can be heavy |
| Street/building geometry | OpenStreetMap + OSMnx | Roads, paths, buildings, and network features | Good public source for urban geometry and reproducible demos | ODbL obligations; OSM completeness varies by region |
| OSM 3D baseline | OSM2World | Convert OSM features into baseline 3D assets | Quick way to prove urban scene assembly before higher-fidelity geometry | OSM-derived outputs still need attribution/license handling |
| Semantic city model | CityJSON + cjio | 3D building/city semantic interchange | Useful intermediate layer before USD/3D Tiles/material tagging | City datasets carry their own license and quality limits |
| Terrain/land cover | USGS 3DEP, NLCD | U.S. elevation and land-cover sources | Strong public authoritative U.S. data baseline | U.S.-centric; resolution varies |
| Global land cover | ESA WorldCover | 10 m global land-cover baseline | Helps non-U.S. demo sites | Land-cover classes need translation to RF/EO/IR material assumptions |
| Scene interchange | OpenUSD | High-performance extensible 3D scene description | Strong neutral `SceneIR` export target and adapter bridge | Needs schema discipline and asset packaging conventions |
| Geospatial scene streaming | 3D Tiles / CesiumJS | Massive 3D geospatial visualization and browser preview | Strong for demo visualization and time-dynamic geospatial scenes | Visualization standard, not a physics simulator |
| Quick 3D assembly | BlenderGIS / blender-osm | Ingest terrain/OSM/buildings into Blender for visual scene preview | Fastest path to a persuasive ROI-to-scene visual | GPL/plugin licensing and reproducibility require care |
| Synthetic labels | BlenderProc | Generate RGB/depth/normal/segmentation/COCO-style training assets from Blender scenes | Strong for labeled dataset demo outputs | GPL-3.0; best kept as a separate pipeline component |
| Physically based rendering | Mitsuba 3 | Spectral/physically based rendering experiments | Strong research renderer for optical/EO-style experiments | Not FLITES; IR/radiometry needs careful modeling |
| Physically based rendering | pbrt-v4 | Spectral reference renderer and validation baseline | Useful for comparing approximations in Mitsuba/Blender | Academic/reference renderer; not a full scene-construction system |
| Atmospheric/radiative transfer | libRadtran | Solar/thermal atmospheric radiation calculations | Useful for atmospheric effects and EO/IR parameter studies | GPL; external process boundary recommended if license is a concern |
| Atmospheric/radiative transfer | Py6S | Python wrapper around 6S radiative transfer model | Easier scripting for atmospheric correction/sensitivity studies | 6S scope is not a full IR scene simulator |
| Atmospheric/radiative transfer | ARTS | IR/microwave/sub-mm atmospheric radiative transfer | Candidate for higher-fidelity atmospheric validation cases | Complex setup; likely later Phase II rather than first demo |
| RF/radio propagation | Sionna RT | Open-source GPU ray tracing for radio propagation | Best open demo backend for RF-like propagation reasoning | Radio propagation is not Xpatch target scattering; position as exploratory RF backend |
| RF terrain baseline | SPLAT! | Terrain-aware Longley-Rice/ITM coverage/path-loss baseline | Fast baseline to compare with Sionna RT for wide-area cases | Legacy/GPL; terrain/clutter simplifications |
| Autonomy/sensors | Gazebo Sim | Robotics/autonomy sensor-platform simulation | Useful if the demo includes autonomous agent trajectories and sensor pose generation | Not RF/EO/IR scene generation by itself |
| Autonomy/sensors | CARLA | Autonomous-system style simulation and sensor suite demos | Could demonstrate closed-loop agent perception workflows | Urban driving focus; not RF/EO/IR defense simulator |
| Asset catalog/provenance | STAC / PySTAC | Catalog source data, derived scene assets, labels, RF/EO outputs | Strong fit for evidence ledger and reproducible scene packages | Metadata can expose sensitive locations; enforce controlled-data policy |
| Data versioning | DVC or lakeFS | Version large generated assets outside Git | Lets Git track recipes/manifests while object storage holds heavy artifacts | Protect remotes; do not leak controlled paths/hashes publicly |
| Experiment tracking | MLflow | Track render/RF jobs, parameters, metrics, models, and outputs | Supports AI/ML evaluation evidence and repeatability | Logs can leak sensitive scene details if not governed |
| Data validation | Great Expectations | Validate input/output data contracts | Useful for automated checks on geospatial and generated dataset artifacts | Needs schema design; cloud features may have separate terms |
| GIS inspection | QGIS | Human inspection of input/output geospatial layers | Useful for validation, screenshots, and analyst review | Desktop/manual workflow; not core backend |

### Recommended demo stack

For the fastest credible public-data demo:

```text
ROI input
  -> GDAL/Rasterio clip DEM + land cover
  -> PDAL process LiDAR if available
  -> OSMnx/OSM2World/CityJSON build roads/buildings
  -> SceneIR manifest
  -> OpenUSD canonical scene
  -> 3D Tiles/Cesium preview
  -> Sionna RT RF propagation sample + SPLAT baseline
  -> BlenderProc/Mitsuba optical preview + labels
  -> STAC/DVC/lakeFS/MLflow provenance
  -> Sigilix evidence and gap report
```

This gives the proposal:

- a working LLM control plane;
- a public-data scene build path;
- visual proof of geo-specific construction;
- RF-ish exploratory propagation proof;
- evidence/provenance reporting;
- a clear path to FLITES/Xpatch adapters.

## How Existing Sigilix Maps to SceneOps

| Existing Sigilix Feature | SceneOps Adaptation |
|---|---|
| Multi-agent PR review ensemble | Domain specialist ensemble: geospatial, RF, EO/IR, validation, compliance |
| `retrieve_codebase` RAG | Retrieve scene specs, data-source docs, simulator adapter docs, prior scene builds |
| SARIF evidence channel | Generic deterministic evidence channel for geospatial validation reports |
| Secret scan / sensitive repo gate | Controlled-data policy gate for ITAR/EAR-sensitive inputs |
| Durable Object review state | Long-running scene-build state machine |
| Review manifest and stale markers | Scene-build manifest and stale-data markers |
| Review memory | Measurement feedback memory and recurring gap suppression/escalation |
| `/sigilix describe` | `/sigilix scene plan`, `/sigilix scene report`, `/sigilix opportunity matrix` |
| Per-repo `sigilix.json` | Per-project scene data policy and adapter configuration |

## Open-Source Implementation Phases

This section is the concrete implementation spine for a Phase II plan. The open-source tools are not
listed as optional inspiration; they are assigned to phases as the initial implementation backends.
The government-simulator path is handled through adapter contracts and transition-partner work.

### Phase 0: Pre-Submission Feasibility Bridge

Purpose:

- reduce Direct-to-Phase-II risk before submission;
- show that Sigilix can coordinate an ROI-to-scene workflow even before FLITES/Xpatch adapters exist;
- create evidence that the team is not starting from a blank page.

Implementation:

- Use **USGS 3DEP** or **SRTM** for elevation.
- Use **NLCD** for U.S. land cover or **ESA WorldCover** for global land cover.
- Use **OSMnx** for roads/buildings and **OSM2World** or **CityJSON/cjio** for quick 3D urban
  geometry.
- Use **GDAL/Rasterio** to clip/reproject assets to the ROI.
- Use a hand-authored or script-generated `SceneIR` v0 manifest.
- Use **OpenUSD**, **glTF**, or **3D Tiles** for a basic scene export.
- Use **CesiumJS** or Blender to create one screenshot or screen-recording.
- Use a Sigilix prompt or script to produce the evidence/gap report.

Outputs:

- one public, uncontrolled ROI recipe;
- one `SceneIR` JSON manifest;
- one visual preview artifact;
- one source/provenance table;
- one gap report explaining what remains for FLITES, Xpatch, calibrated EO/IR, and validated RF.

Acceptance criteria:

- a reviewer can see that terrain, land cover, and urban features were assembled for a real region;
- every input source has a URL/license/provenance note;
- the report explicitly avoids claiming RF/EO/IR simulator compatibility.

### Phase 1: Sigilix SceneOps Control Plane

Purpose:

- adapt Sigilix from code-review orchestration to scene-build orchestration;
- keep heavy geospatial/GPU work out of the Cloudflare Worker;
- make each scene build auditable and reproducible.

Implementation:

- Add SceneOps job records modeled after the existing PR review state machine:
  - `scene-plan`;
  - `scene-ingest`;
  - `scene-build`;
  - `scene-render-eo`;
  - `scene-render-rf`;
  - `scene-validate`;
  - `scene-report`.
- Use **Cloudflare Queue/Durable Object** patterns for dispatch, dedupe, status, retry, and watchdogs.
- Store large artifacts in object storage; store references and metadata in `SceneIR`, **STAC/PySTAC**,
  and Sigilix evidence records.
- Track heavy job versions with **DVC** or **lakeFS**.
- Track run parameters, metrics, and outputs with **MLflow**.
- Add controlled-data policy gates before any LLM call or external job dispatch.

Outputs:

- SceneOps status model;
- `SceneIR` v0 schema;
- source registry schema;
- STAC item/collection conventions;
- object-storage layout;
- controlled-data mode policy.

Acceptance criteria:

- Sigilix can start, track, and report a scene build without running native geospatial tools inside
  the Worker;
- every artifact has a content-addressed or versioned pointer;
- public-data mode and controlled-data mode are distinct.

### Phase 2: Geospatial Ingestion Backend

Purpose:

- turn ROI coordinates into normalized terrain, land-cover, structure, road, and optional LiDAR
  layers.

Implementation:

- Run **GDAL/OGR** in a containerized worker for format conversion, clipping, reprojection, GeoTIFF,
  COG, GeoPackage, and vector normalization.
- Use **Rasterio** for Python-native DEM and land-cover raster processing.
- Use **PDAL** for LAS/LAZ/EPT point-cloud workflows where LiDAR exists.
- Use **OSMnx** for OSM road/building extraction.
- Use **OSM2World** for rapid OSM-to-3D baseline assets when CityJSON or authoritative building
  models are not available.
- Use **CityJSON/cjio** when semantic building/city datasets exist.
- Use **QGIS** as a manual inspection and screenshot tool for analyst review.

Inputs:

- ROI polygon or bounding box;
- target CRS;
- desired resolution;
- allowed source list;
- public-data or controlled-data mode.

Outputs:

- normalized DEM/DSM;
- land-cover raster clipped to ROI;
- vector roads/buildings/water/vegetation layers;
- optional point-cloud-derived terrain/building features;
- STAC metadata for every source and derived asset.

Acceptance criteria:

- same ROI produces deterministic normalized assets when source versions are pinned;
- transformed assets record CRS, resolution, source, timestamp, and processing command;
- ingestion failures are surfaced as explicit Sigilix gaps, not silent missing layers.

### Phase 3: SceneIR and Canonical Scene Assembly

Purpose:

- convert normalized geospatial layers into a sensor-independent scene package.

Implementation:

- Generate `SceneIR` from normalized assets.
- Use **OpenUSD** as the canonical 3D scene graph for terrain, structures, material assignments,
  time/season variants, sensor poses, and future simulator adapters.
- Export **glTF** for lightweight inspection where USD tooling is unavailable.
- Export **3D Tiles** for browser-scale geospatial visualization through **CesiumJS**.
- Map land-cover and feature classes into initial material classes:
  - RF material placeholders;
  - EO albedo/spectral placeholders;
  - IR emissivity/thermal placeholders;
  - explicit unknown/needs-measurement classes.

Outputs:

- `scene.json` (`SceneIR`);
- `scene.usd` or equivalent USD package;
- `scene.glb` or glTF package;
- 3D Tiles preview package;
- material assumption table;
- missing-material report.

Acceptance criteria:

- one ROI can be inspected as a 3D scene;
- scene geometry, material classes, sensor poses, and provenance are connected through IDs;
- unknown materials are explicit and reviewable.

### Phase 4: EO/IR Demonstration Backend

Purpose:

- produce EO-style synthetic imagery and labeled data from the canonical scene;
- define the path toward calibrated EO/IR rendering and FLITES compatibility.

Implementation:

- Use **Blender/Cycles** for fast visual rendering and scene authoring.
- Use **BlenderProc** for synthetic dataset outputs:
  - RGB;
  - depth;
  - normal maps;
  - semantic segmentation;
  - instance segmentation;
  - COCO/BOP-style labels where relevant.
- Use **Mitsuba 3** for spectral/physically based reference rendering and material studies.
- Use **pbrt-v4** as an optional reference renderer for physically based comparison.
- Use **Py6S** for VIS/NIR/SWIR atmospheric correction experiments.
- Use **libRadtran** for atmospheric radiance/transmission lookup tables.
- Evaluate **ARTS** for higher-fidelity IR/microwave atmospheric cases later in Phase II.

Outputs:

- EO preview images;
- labeled synthetic dataset slice;
- atmospheric parameter table;
- material/spectral assumption table;
- FLITES adapter-gap report.

Acceptance criteria:

- the demo can render a geo-specific visual scene from the same `SceneIR`;
- labels are generated from scene geometry rather than manually drawn;
- EO/IR limitations are explicit: this is an exploratory backend until calibrated data and FLITES
  integration are available.

### Phase 5: RF Demonstration Backend

Purpose:

- generate RF-like propagation outputs from the same scene representation;
- show cross-modal consistency between scene geometry and RF analysis;
- define the gap to Xpatch.

Implementation:

- Use **Sionna RT** as the primary open RF ray-tracing backend.
- Convert `SceneIR`/OpenUSD geometry and material placeholders into Sionna-compatible scene inputs.
- Use transmitter/receiver/sensor poses from `SceneIR`.
- Generate:
  - paths;
  - path gain;
  - RSS/SINR-style maps where supported;
  - ray/path visualizations;
  - material sensitivity experiments.
- Use **SPLAT!** as a terrain-aware Longley-Rice/ITM baseline for broader coverage comparison.

Outputs:

- RF propagation preview;
- RF heatmap/radio-map artifact;
- ray/path visualization;
- Sionna-vs-SPLAT comparison note;
- Xpatch adapter-gap report.

Acceptance criteria:

- RF outputs use the same ROI, coordinate frame, terrain, and sensor poses as EO outputs;
- the report states Sionna RT is an exploratory radio-propagation backend, not an Xpatch replacement;
- Xpatch-specific scattering/signature requirements are isolated for partner/customer integration.

### Phase 6: Validation, Evidence, and Measurement Assimilation

Purpose:

- make the scene build auditable;
- establish the path for improving fidelity when measured databases become available.

Implementation:

- Use **Great Expectations** to validate geospatial and dataset contracts:
  - CRS present;
  - resolution within expected range;
  - required layers present;
  - label files match rendered images;
  - no uncontrolled data in public mode.
- Use **MLflow** for run metadata, parameters, metrics, artifacts, and evaluation results.
- Use **STAC/PySTAC** for source and derived asset catalogs.
- Use **DVC/lakeFS** for data versioning and reproducibility.
- Extend Sigilix's evidence/synthesis pattern to produce:
  - readiness report;
  - source coverage report;
  - assumption register;
  - material uncertainty report;
  - modality consistency report;
  - controlled-data audit report.

Outputs:

- validation report;
- scene evidence ledger;
- measured-data assimilation plan;
- confidence score by scene layer and modality.

Acceptance criteria:

- every generated image/map/label can be traced to input sources and processing runs;
- failed validation checks become Sigilix findings;
- measurement gaps are tracked as first-class artifacts.

### Phase 7: Simulator Adapter and Transition Layer

Purpose:

- move from open demo backends toward government simulator compatibility.

Implementation:

- Define adapter contracts:
  - `SceneIR -> FLITES-like EO/IR package`;
  - `SceneIR -> Xpatch-like RF package`;
  - `SceneIR -> AFSIM/SSGM-friendly metadata package` if transition partners request it.
- Use open exports (**OpenUSD**, **glTF**, **3D Tiles**, **CityJSON**) as intermediate inspection
  and interchange artifacts.
- Engage transition partners to obtain:
  - required scene file formats;
  - coordinate/material conventions;
  - sensor model expectations;
  - validation fixtures;
  - acceptable unclassified test cases.
- Maintain adapter-gap reports until direct simulator tests pass.

Outputs:

- adapter interface specification;
- open export package;
- FLITES/Xpatch mapping document;
- partner integration checklist;
- transition demo plan.

Acceptance criteria:

- every field needed by a simulator adapter is either present in `SceneIR` or listed as a gap;
- no proposal language claims direct compatibility until a simulator package has been tested;
- transition partners can review concrete schema and artifact examples.

### Phase 8: AI/ML Evaluation Demonstration

Purpose:

- satisfy the Phase II requirement to demonstrate relevance to AI/ML tasks such as geolocation, ATR,
  scene understanding, or autonomous-system evaluation.

Implementation:

- Use the generated BlenderProc/Mitsuba/Cesium/Sionna artifacts as synthetic data sources.
- Use **MLflow** to track experiment runs.
- Use **Great Expectations** to verify dataset structure before training/evaluation.
- Candidate first tasks:
  - geolocation/classification from rendered scene views;
  - scene-understanding segmentation with synthetic labels;
  - sensor-pose recovery from generated imagery;
  - RF map prediction or localization from Sionna outputs.
- If autonomy simulation is needed, use **Gazebo Sim** first; use **CARLA** only if the demo is
  ground-vehicle/urban-driving oriented.

Outputs:

- baseline dataset;
- synthetic-augmented dataset;
- metrics report;
- model card or experiment card;
- Sigilix-generated evaluation summary.

Acceptance criteria:

- the evaluation compares a baseline against a synthetic-data condition;
- metrics and limitations are reported honestly;
- the report does not claim broad ATR/geolocation improvement from a narrow demo.

## Demo Definition

The Phase II demo should not try to prove all of FLITES/Xpatch equivalence in one step. It should
prove an end-to-end framework:

1. User submits ROI and mission intent.
2. Sigilix SceneOps creates a scene-build plan.
3. Geospatial pipeline sources terrain, land cover, and structures.
4. SceneIR is generated.
5. Open visual preview is exported.
6. RF exploratory output is generated.
7. EO/IR exploratory output is generated.
8. Ground-truth labels are produced.
9. Sigilix produces a readiness/evidence report.
10. Human reviewer approves, flags gaps, or requests measured-data refinement.

## Proposed Evaluation Claims

Use cautious wording:

- "We will evaluate whether SceneOps-generated synthetic data improves downstream task performance
  relative to a no-synthetic-data baseline."
- "Candidate tasks include geolocation, ATR, scene understanding, and sensor-fusion pretraining."
- "The first Phase II evaluation will prioritize an unclassified public-data task where labels can be
  generated or obtained reproducibly."
- "Where government-provided measured databases are available, we will use them to calibrate
  material, atmospheric, and sensor models under the approved data-handling plan."

Avoid:

- "The system will improve ATR performance" before experiments exist.
- "The system is FLITES/Xpatch compatible" before adapters are demonstrated.
- "The system generates high-fidelity RF/EO/IR scenes" before validation exists.

## Compliance and Controlled-Data Plan

The PDF flags ITAR/EAR risk. Treat this as a first-class proposal element.

SceneOps should support three operating modes:

### Mode A: Public-data demo

- Public solicitation text.
- Public geospatial data.
- Open-source tools.
- External commercial LLMs allowed only for uncontrolled metadata, planning, and reports.
- No controlled technical data.

### Mode B: Controlled unclassified workflow

- CMMC Level 2 controls.
- Role-based access.
- Audit logs.
- Approved storage.
- Model/provider allowlist.
- Human approval before any controlled content enters an LLM path.
- Option for local/on-prem model execution.

### Mode C: Government/secure transition workflow

- Government-provided datasets.
- Classified or export-controlled sources handled only inside approved environments.
- Adapter execution and model calls configured to meet customer security requirements.
- Sigilix evidence ledger records what was used without leaking sensitive content.

The proposal should say:

> Sigilix's current sensitive-repository gate will be extended into a controlled-data policy gate for
> SceneOps. Public-data demonstrations can use commercial model APIs, while controlled datasets will
> require an approved environment and model-routing policy before content is processed.

## Risk Register

| Risk | Severity | Mitigation |
|---|---:|---|
| Sigilix is not currently a scene generator | High | Position it as production AI orchestration; add geospatial/scene adapters in Phase II |
| Phase-I-equivalent expectation may require prior scene-building evidence | High | Build a small pre-submission ROI-to-SceneIR artifact if possible; otherwise state prior capability is AI framework, not scene generation |
| FLITES/Xpatch interfaces may not be publicly available | High | Define adapter contracts; use open backends for demo; engage transition partners early |
| Open RF backend is not equivalent to Xpatch | High | Use Sionna RT as exploratory propagation backend only; document Xpatch gap explicitly |
| EO/IR radiometry is hard and data-dependent | High | Start with optical/spectral/atmospheric approximations; calibrate when measured data is available |
| OSM completeness varies | Medium | Select demo ROI with adequate coverage; combine with authoritative sources where available |
| OSM ODbL obligations | Medium | Track attribution and derivative-data handling in source registry |
| GPL components create licensing constraints | Medium | Run GPL tools as optional external tools or containers; keep core interfaces clean |
| Cloudflare Worker not suited to heavy geospatial jobs | Medium | Keep Worker as control plane; run heavy processing in containerized workers or external job runners |
| Controlled-data handling | High | Add policy gates, local model mode, audit logs, and environment-specific routing |

## Recommended Proposal Language

### One-paragraph abstract language

Arc & Anchor proposes **Sigilix SceneOps**, an AI framework for geo-specific multimodal scene
construction that adapts an existing production multi-agent LLM orchestration platform to the RF and
EO/IR synthetic-data domain. Sigilix already operates in production for technical reasoning,
retrieval, deterministic evidence injection, structured output validation, asynchronous job
execution, and auditable human-in-the-loop automation. Under Phase II, we will extend this proven
framework with geospatial data ingestion, a sensor-independent SceneIR representation, RF and EO/IR
simulator adapter contracts, validation workflows, and controlled-data governance. The resulting
prototype will ingest a region of interest, source representative geospatial and environmental data,
construct scene assets, export to open demonstration backends and simulator-specific adapter
interfaces, generate ground-truth metadata, and produce evidence reports that support transition to
FLITES, Xpatch, and related government simulation environments.

### Existing capability language

Sigilix is not a concept-only AI agent. It is an operational Cloudflare Worker application that
already coordinates model calls, retrieval, deterministic evidence, specialist synthesis,
long-running asynchronous execution, and human review workflows in production. This reduces
execution risk for the AI-framework portion of the proposed work. The remaining Phase II effort is
domain adaptation: integrating geospatial and sensor-simulation tools, defining a sensor-independent
scene representation, and validating generated scenes for RF and EO/IR synthetic-data use cases.

### Scope boundary language

The proposed work does not require replacing FLITES, Xpatch, or other established government
simulation tools. Instead, Sigilix SceneOps provides a modular AI control plane and scene
representation layer that can target multiple simulation backends through adapters. This preserves
compatibility with existing tools while allowing fidelity, resolution, and data-source choices to be
adjusted per scenario.

### Phase-I-equivalent caveat

The offeror's existing production capability demonstrates the AI orchestration, evidence synthesis,
and auditable automation components needed for this topic. Prior to or at Phase II kickoff, the team
will use public, uncontrolled geospatial sources and open-source rendering/propagation tools to
establish a baseline ROI-to-SceneIR feasibility artifact. Phase II will mature that artifact into a
prototype software system with simulator adapter contracts, validation workflows, and relevant
demonstrations.

## No-Go Claims

Do not put these in the proposal:

- "Sigilix already generates RF and EO/IR scenes."
- "Sigilix is already compatible with FLITES and Xpatch."
- "Sigilix already models radiometric or electromagnetic behavior."
- "Sigilix has already improved ATR/geolocation model performance."
- "Open-source tools fully replace government simulators."
- "Commercial LLM APIs can process ITAR/EAR data by default."

Use these instead:

- "Sigilix already provides the production AI orchestration layer."
- "Phase II adapts Sigilix to scene construction."
- "Open-source tools provide the initial public-data demonstration backends."
- "FLITES/Xpatch compatibility will be implemented through adapter contracts and transition-partner
  integration."
- "Controlled technical data will be processed only under approved data-handling policies."

## Draft Milestone Schedule

| Month | Milestone |
|---:|---|
| 0, pre-award | Feasibility bridge: one public ROI, source table, `SceneIR` example, visual preview, Sigilix gap report |
| 1 | SceneOps control-plane design: job states, storage layout, STAC/DVC/MLflow conventions, controlled-data policy |
| 2 | Geospatial ingestion backend: GDAL/Rasterio/OSMnx public ROI pipeline with deterministic source/provenance output |
| 3 | LiDAR/semantic-city extension: PDAL where data exists, OSM2World/CityJSON path, normalized building/road layers |
| 4 | Canonical scene assembly: `SceneIR` generator, OpenUSD scene package, glTF fallback, material assumption table |
| 5 | Browser/demo visualization: 3D Tiles/Cesium viewer with terrain, buildings, land cover, sensor poses, source overlays |
| 6 | EO-style backend: BlenderProc labels, Blender/Mitsuba renders, Py6S/libRadtran atmospheric parameter hooks |
| 7 | RF backend: Sionna RT scene adapter, SPLAT terrain baseline, RF map/path visualization, Xpatch gap report |
| 8 | Sigilix domain specialists: geospatial/RF/EO/IR/validation/compliance prompts and structured findings |
| 9 | Validation/evidence suite: Great Expectations checks, STAC catalog, MLflow run cards, Sigilix readiness report |
| 10 | AI/ML evaluation: baseline vs synthetic-augmented experiment design and first public-data run |
| 11 | Transition adapter package: FLITES/Xpatch mapping document, partner review checklist, simulator-interface gap closure |
| 12 | Prototype delivery: scene packages, synthetic outputs, labels, evidence ledger, demo report, Phase III transition plan |

If the solicitation expects a longer Phase II, stretch this into 18-24 months with more time for
adapter integration, measured-data calibration, and customer demonstrations.

Milestone logic for reviewers:

- Months 0-4 prove the core geo-specific scene-construction path.
- Months 5-7 prove multimodal outputs from the same scene representation.
- Months 8-9 prove Sigilix's differentiator: AI review, evidence, validation, and controlled-data
  governance.
- Months 10-12 prove the Phase II requirement around relevant AI/ML evaluation, demonstration, and
  transition planning.

## Potential Proposal Deliverables

- **Selection-support deliverables before or at proposal submission:**
  - Sigilix production capability summary.
  - ROI-to-SceneIR feasibility artifact, if built before submission.
  - Open-source implementation map with licensing/compliance notes.
  - Partner/consultant capability letters for RF, EO/IR, geospatial, or CMMC gaps if available.
  - FLITES/Xpatch adapter-gap table.
- **Phase II technical deliverables:**
  - SceneOps architecture document.
  - SceneIR v0 schema and examples.
  - Data-source registry and provenance ledger.
  - Public-data ROI scene package.
  - OpenUSD/glTF/3D Tiles visualization package.
  - EO-style synthetic imagery and label package.
  - RF exploratory output package.
  - Validation and evidence reports.
  - FLITES/Xpatch adapter interface specification.
  - AI/ML evaluation report.
  - Demonstration report.
  - Transition partner engagement report.
- **Phase III/commercialization deliverables:**
  - Government simulator integration roadmap.
  - Commercial digital-twin/RF-planning/autonomy-data product plan.
  - Controlled-data deployment architecture.
  - Pricing/support model for SceneOps as a productized Sigilix extension.

## Source Links for Toolchain

- DoW SBIR/STTR program and evaluation factors: https://www.defensesbirsttr.mil/SBIR-STTR/Program/
- SBIR.gov proposal evaluation tutorial: https://www.sbir.gov/tutorials/preparing-proposal/tutorial-1
- SBIR/STTR policy directive: https://www.sbir.gov/about/policies
- Army Direct-to-Phase-II overview: https://armysbir.army.mil/faq/what-is-the-difference-between-a-phase-ii-and-a-direct-to-phase-ii-contract-2/
- GDAL: https://gdal.org/en/stable/
- Rasterio: https://rasterio.readthedocs.io/
- PDAL: https://pdal.io/en/latest/about.html
- OSMnx: https://osmnx.readthedocs.io/
- OSM2World: https://github.com/tordanik/OSM2World
- CityJSON: https://www.ogc.org/standards/cityjson/
- OpenStreetMap license: https://www.openstreetmap.org/copyright/
- USGS 3DEP: https://www.usgs.gov/3d-elevation-program
- USGS Annual NLCD: https://www.usgs.gov/centers/eros/science/annual-national-land-cover-database
- ESA WorldCover: https://esa-worldcover.org/en
- OpenUSD: https://openusd.org/docs/index.html
- Cesium 3D Tiles: https://cesium.com/why-cesium/3d-tiles/
- OGC 3D Tiles: https://www.ogc.org/standards/3DTiles/
- BlenderGIS: https://blendergis.com/
- blender-osm: https://wiki.openstreetmap.org/wiki/Blender-osm
- BlenderProc: https://github.com/DLR-RM/BlenderProc
- Mitsuba 3: https://github.com/mitsuba-renderer/mitsuba3
- pbrt-v4: https://github.com/mmp/pbrt-v4
- libRadtran: https://libradtran.org/
- Py6S: https://py6s.readthedocs.io/
- ARTS: https://atmtools.github.io/arts-docs-2.6/features.html
- Sionna RT: https://nvlabs.github.io/sionna/rt/
- SPLAT!: https://gbppr.net/splat/index.html
- Gazebo Sim: https://github.com/gazebosim/gz-sim
- CARLA: https://github.com/carla-simulator/carla
- STAC: https://www.ogc.org/standards/stac/
- PySTAC: https://stac-utils.github.io/pystac/
- DVC: https://dvc.org/doc/user-guide/what-is-dvc
- lakeFS: https://docs.lakefs.io/latest/project/
- MLflow: https://github.com/mlflow/mlflow
- Great Expectations: https://github.com/great-expectations/great_expectations
