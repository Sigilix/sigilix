// SIG-377 / P0a: `interface Env` moved verbatim out of `src/index.ts` to break the
// app-wide import cycle (index declared it; many modules imported it back from index).
// Leaf module: Cloudflare binding types (KVNamespace, VectorizeIndex, D1Database, Ai,
// Queue, DurableObjectNamespace, ...) are ambient globals from the generated worker
// types, so no import is needed for them. The only import is the `JobMessage` that
// `Queue<JobMessage>` is parameterized with. No binding parameterizes a DO *class*
// (all DurableObjectNamespace are the bare generic), so this stays a clean leaf with
// no shared/types -> do coupling. Type-only move: zero runtime, zero behavior change.

import type { JobMessage } from "./job"
import type { AwsBedrockEnv } from "./env-aws-bedrock"

// sig-worker-debrand-openclaw: OPENCLAW_ → SIGILIX_ rebrand of the Worker's config
// vars, secrets, and resource bindings, done BACK-COMPAT. `interface Env` below keeps
// the legacy `OPENCLAW_<X>` names (the live prod keys) so the ~5,000 existing call
// sites type-check unchanged. `SigilixAliasEnv` derives the NEW canonical
// `SIGILIX_<X>` sibling for each — all optional (unset until the founder sets them).
// `normalizeEnv` (@/src/shared/util/normalize-env) mirrors the two at each entry
// point, SIGILIX_-preferred with OPENCLAW_ fallback, and returns `NormalizedEnv`.
export interface Env extends AwsBedrockEnv {
  OPENCLAW_STATE: KVNamespace
  // Vectorize index storing 768-dim embeddings of code chunks per repo.
  OPENCLAW_CODE_INDEX: VectorizeIndex
  // Agent-memory store (SIG-483): 768-dim embeddings of the local CLI agent's
  // durable per-(user, repo) memories. Tenant isolation is the Vectorize
  // namespace `<userId>/<repoId>` lowercased — a query in a namespace can only
  // match vectors written to it. Backs PUT /v1/memory + POST /v1/memory/query.
  // Provisioned via `wrangler vectorize create boreas-agent-memory
  // --dimensions=768 --metric=cosine`.
  OPENCLAW_AGENT_MEMORY_INDEX: VectorizeIndex
  // SIG-45: D1 database holding the FTS5 (BM25) lexical mirror of the same
  // code chunks. Optional — when unbound (or the OPENCLAW_RETRIEVAL_HYBRID
  // flag is off) retrieval stays pure-vector and the indexer skips the
  // dual-write. Provisioned via `wrangler d1 create sigilix-lexical-index`.
  OPENCLAW_LEXICAL_INDEX?: D1Database
  // sig-training-data-consent: the PHYSICALLY SEPARATE, consent-gated long-term
  // training corpus. A DEDICATED R2 bucket — a DIFFERENT binding from every
  // operational store (KV OPENCLAW_STATE, D1 SIGILIX_PLATFORM_DB, the Vectorize
  // indexes) — so non-consented data has NO code path into it: the ONLY writer
  // is `retainForTraining` (@/features/training-consent), which is itself gated
  // on consent AND the SIGILIX_TRAINING_RETENTION_MODE master flag. Records are
  // partitioned per installation (`installation/<id>/...` key prefix) for per-org
  // isolation + a prefix-scoped right-to-forget purge. OPTIONAL: when the binding
  // is absent (the launch default — the bucket is intentionally not yet
  // provisioned) the store no-ops, so retention is impossible even if the flag
  // were flipped. Provision via `wrangler r2 bucket create sigilix-training-data`
  // and uncomment the wrangler.toml [[r2_buckets]] block only AFTER the legal
  // prerequisites in src/features/training-consent/README.md are met.
  SIGILIX_TRAINING_DATA?: R2Bucket
  // Workers AI binding for embedding queries at retrieval time.
  AI: Ai
  // Cloudflare Queue producer binding. Webhook handlers enqueue
  // JobMessages here; the queue() handler below consumes them. The
  // Queue exists separately on Cloudflare and was created via
  // `wrangler queues create openclaw-jobs` before first deploy.
  OPENCLAW_JOBS: Queue<JobMessage>
  LINEAR_API_KEY: string
  LINEAR_WEBHOOK_SECRET: string
  // SIG-144 (Linear unification cutover): the NEW agent-app's webhook signing secret.
  // During the cutover an inbound webhook may be HMAC-signed with EITHER LINEAR_WEBHOOK_SECRET
  // (legacy triage app) OR this one (agent app), so verification accepts either. Optional —
  // unset preserves legacy-only behavior (only LINEAR_WEBHOOK_SECRET is accepted).
  OPENCLAW_LINEAR_AGENT_WEBHOOK_SECRET?: string
  // SIG-406: OLLAMA_API_KEY is now LEGACY — it serves non-review command paths
  // (`/api/chat`, @-mention agent loop, indexer) and local eval testing (a `:cloud`
  // model override routes to Ollama Turbo). The review ensemble runs on OpenRouter.
  OLLAMA_API_KEY: string
  // SIG-406 (OpenRouter alpha): the PRIMARY review API key — every review specialist +
  // the synthesizer + the dispatcher run on OpenRouter ids, and the per-call key is
  // selected by model-id shape (slash-id → this key). Review FAILS CLOSED without it.
  // Typed optional so the Worker still boots without it (non-review paths use
  // OLLAMA_API_KEY); a review that selects OpenRouter without it returns missing_api_key.
  OPENROUTER_API_KEY?: string
  LINEAR_OAUTH_CLIENT_ID?: string
  LINEAR_OAUTH_CLIENT_SECRET?: string
  OPENCLAW_LINEAR_AGENT_CLIENT_ID?: string // dedicated agent-app OAuth; falls back to LINEAR_OAUTH_CLIENT_ID
  OPENCLAW_LINEAR_AGENT_CLIENT_SECRET?: string // dedicated agent-app OAuth; falls back to LINEAR_OAUTH_CLIENT_SECRET
  GITHUB_APP_ID?: string
  GITHUB_PRIVATE_KEY?: string
  GITHUB_WEBHOOK_SECRET?: string

  // sig-gitlab-adapter (GitLab support PR 2): the GitLab MR-review path. All
  // optional — unset leaves `POST /gitlab/webhook` returning 503, so a deploy
  // without GitLab configured is unaffected. Resolved SIGILIX_-first via the
  // normalizeEnv shim like every other SIGILIX_ var.
  //   - SIGILIX_GITLAB_WEBHOOK_SECRET — the value GitLab echoes VERBATIM in the
  //     plaintext `X-Gitlab-Token` header; constant-time-compared on ingress.
  //   - SIGILIX_GITLAB_TOKEN — the per-tenant GitLab access token (Project/Group
  //     Access Token or PAT), sent as `PRIVATE-TOKEN` against REST v4. v0 is a
  //     single global token; a per-tenant `projectId -> token` mapping (mirroring
  //     GitHub installation -> token) is the pre-launch follow-up.
  //   - SIGILIX_GITLAB_BASE_URL — REST origin WITHOUT `/api/v4` (default
  //     `https://gitlab.com`); a self-managed instance sets its own origin.
  //   - SIGILIX_GITLAB_ALLOWED_PROJECTS — PR-3 pre-launch project gate. A
  //     comma-separated list of numeric project ids and/or `group/project` paths.
  //     When set, ONLY listed projects (plus any with their own per-project token)
  //     are reviewed; everything else is ignored + logged. Unset -> all projects
  //     allowed (back-compat with the single global token). See
  //     `isGitLabProjectAllowlisted`. Per-project tokens live in KV OPENCLAW_STATE
  //     under `gitlab-project-token:<projectId>` (see `resolveGitLabProjectToken`).
  SIGILIX_GITLAB_WEBHOOK_SECRET?: string
  SIGILIX_GITLAB_TOKEN?: string
  SIGILIX_GITLAB_BASE_URL?: string
  SIGILIX_GITLAB_ALLOWED_PROJECTS?: string
  // sig-gitlab-connector: the GitLab OAuth APPLICATION credentials that power the
  // portal's one-click "Connect GitLab" flow (SEPARATE from the read_user login
  // OAuth). This app requests the broad `api` scope so the connect callback can
  // list the user's projects, auto-create the MR webhook, and provision a
  // project access token as the review credential. Registered redirect URI:
  // `${OPENCLAW_BASE_URL}/gitlab/connect/callback`. Absent -> the connect routes
  // 503 and the portal card shows "not configured" (the existing webhook-driven
  // review path is unaffected). Self-managed instances authorize against
  // SIGILIX_GITLAB_BASE_URL; gitlab.com is the default.
  SIGILIX_GITLAB_OAUTH_CLIENT_ID?: string
  SIGILIX_GITLAB_OAUTH_CLIENT_SECRET?: string

  // Phase 5 user-OAuth (ARC-163). Same GitHub App as GITHUB_APP_ID — its
  // OAuth credentials live on the App settings page next to the JWT
  // private key. Only used to authenticate human users into the Sigilix
  // dashboard at app.sigilix.ai; repo access still goes through the
  // server-to-server JWT path in github-app.ts.
  GITHUB_OAUTH_CLIENT_ID?: string
  GITHUB_OAUTH_CLIENT_SECRET?: string
  // sig-user-identity: Google (OIDC) user login. When unset, GET /auth/providers
  // reports google:false and the portal hides the "Continue with Google" button
  // (the kickoff route also 503s), so an unconfigured deploy degrades gracefully.
  // Registered redirect URI: https://api.sigilix.ai/auth/google/callback
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  // sig-gitlab-oauth-login: GitLab user login (dashboard sign-in) REUSES the same
  // SIGILIX_GITLAB_OAUTH_CLIENT_ID/_SECRET declared above — one group-owned GitLab
  // OAuth application powers BOTH flows. They stay independent by differing on the
  // redirect URI + scope: the connector uses `/gitlab/connect/callback` + scope
  // `api`, while login uses `/auth/gitlab/callback` + the minimal `read_user email`
  // (login must NOT request `api`). When the credentials are unset, GET
  // /auth/providers reports gitlab:false and the portal hides the "Sign in with
  // GitLab" button (the kickoff route also 503s), so an unconfigured deploy
  // degrades gracefully. The GitLab instance origin reuses SIGILIX_GITLAB_BASE_URL
  // (default https://gitlab.com; a self-managed instance overrides it).
  // sig-user-identity PHASE 1: org-wide MFA (TOTP). "on" un-stubs the (still
  // incomplete) enrollment/verify endpoints for testing; anything else keeps
  // them 501. MFA is NOT enforced on login yet regardless — see auth-totp.ts.
  SIGILIX_MFA_MODE?: string
  // 32 random bytes, base64url-encoded. Used to AES-GCM-encrypt user
  // access tokens at rest in OPENCLAW_STATE. Rotating this invalidates
  // every active session.
  OPENCLAW_SESSION_ENCRYPTION_KEY?: string
  // sig-email-verification: Resend API key (secret). Transactional email is sent
  // From "Sigilix <verify@sigilix.ai>" (verified sending domain). Absent → the
  // sender fails soft (signup still succeeds; the portal shows a "resend").
  RESEND_API_KEY?: string
  // Public origin for OAuth callbacks (must match the GitHub App's
  // configured callback URL). Defaults to https://app.sigilix.ai.
  OPENCLAW_BASE_URL?: string
  // #155 onboarding-backend slice 3 (portal endpoints). Comma-separated
  // EXACT origins allowed to make credentialed cross-origin requests
  // (CORS + `SameSite=None` session cookie) against the session-authed
  // onboarding + key routes. Defaults to
  // "https://app.sigilix.ai,http://localhost:3300" when unset. See
  // src/lib/portal-cors.ts.
  OPENCLAW_PORTAL_ORIGINS?: string
  // #155 onboarding-backend slice 3. When set, gates two redirect changes
  // (byte-identical to today when unset): the GitHub OAuth login callback's
  // default success destination becomes `${OPENCLAW_PORTAL_URL}/setup`
  // (instead of /auth/welcome), and the GitHub App Setup URL handler
  // (`GET /setup`) 302s to `${OPENCLAW_PORTAL_URL}/setup?installed=1`
  // instead of rendering the plaintext-key page — the portal mints its own
  // key afterward via POST /v1/keys. e.g. https://app.sigilix.ai
  OPENCLAW_PORTAL_URL?: string
  // SIG-132: VALUES are `<owner>/<repo>` lowercased (the Vectorize
  // namespace), e.g. {"ARC":"sigilix/rubberfit"}.
  OPENCLAW_TEAM_REPO_MAP?: string
  OPENCLAW_MODEL?: string
  OPENCLAW_TEAM_KEY?: string
  OPENCLAW_MENTION_TRIGGERS?: string
  // Phase 1 — Linear PR-aware @-mentions.
  // OPENCLAW_TEAM_GITHUB_REPO_MAP carries owner+repo identity per team
  // (separate from OPENCLAW_TEAM_REPO_MAP which is namespace-only).
  // Schema: {"ARC":{"owner":"Sigilix","repo":"rema-portal"}}
  OPENCLAW_TEAM_GITHUB_REPO_MAP?: string
  // Schema: {"<owner>/<repo>":"<id>","<owner>":"<id>"}
  // Lookup order: exact owner/repo, then owner-only fallback.
  OPENCLAW_GITHUB_INSTALLATION_MAP?: string
  // ARC-239 (2026-05-16): the `OPENCLAW_INDEXED_REPOS` env-var
  // allowlist was deleted. The agent loop's `retrieve_codebase` tool
  // now derives the indexed-repo universe from `repo-index-manifest:*`
  // KV records — ARC-235's bootstrap writer + ARC-238's uninstall
  // cleanup make that the live source of truth. Same anti-pattern as
  // ARC-232's allowlist removal.
  // "strict" → return 500 when team/installation maps are inconsistent.
  // Anything else (including unset, "warn", "STRICT", typos) → warn only.
  OPENCLAW_VALIDATE_GITHUB_INSTALLATIONS?: string
  // Phase 3 — agent loop (tool-using) per-surface flags + provider
  // kill-switch. All "on"|"off" strings (case-sensitive); unset or
  // anything other than "on" defaults to off.
  //
  // ARC-280: `OPENCLAW_AGENTIC_GITHUB_MODE` only gates the @-mention
  // reply agent loop now (`github-mention.ts`). The Phase 3 PR
  // reviewer that used to read this flag was deleted. Kept on the
  // Env type so the mention path still type-checks.
  OPENCLAW_AGENTIC_LINEAR_MODE?: string
  OPENCLAW_AGENTIC_GITHUB_MODE?: string
  // Provider kill-switch for the /api/chat path. Independent of the
  // per-surface agentic flags — flipping this off disables the chat
  // endpoint without redeploying. Both runAgentLoop AND ad-hoc chat()
  // callers honor it.
  OLLAMA_CHAT_ENABLE?: string

  // ARC-280: `OPENCLAW_ENSEMBLE_REVIEW_MODE` deleted. The ensemble is
  // the only review pipeline now; the shadow / post / off
  // discriminator served the dual-path era and has no remaining
  // routing role.
  // ARC-183: comma-separated owner/repo DENYlist. When a repo is
  // listed here, Sigilix never fetches its diff or sends content to
  // any LLM. Use for compliance / customer-data / secrets-heavy
  // repos. Empty/unset = no sensitive repos. Match is
  // case-insensitive on `owner/repo`.
  OPENCLAW_SENSITIVE_REPOS?: string
  // Per-PR cap on retrieve_codebase calls (covers pre-flight + every
  // specialist follow-up + synth conflict-verification). Default 3.
  OPENCLAW_ENSEMBLE_MAX_RETRIEVE_CALLS_PER_PR?: string
  // Phase 4 router (Option C consolidation): when "on", router decides
  // which specialists fire based on static signals from the diff
  // (lockfile→security, auth-path→security, docs-only→none, etc.).
  // Default "off" = always-fire all four specialists, which is the
  // baseline-data-collection mode reviewers wanted for Phase 4a.
  // Phase 4b activation = flag-flip, no code change.
  OPENCLAW_ENSEMBLE_ROUTER_ENABLED?: string

  // SIG-226 (SIG-224 Phase 1) — dynamic specialist dispatcher mode.
  //   - "off"           (default): dispatcher disabled, no telemetry,
  //                      no LLM call.
  //   - "shadow":        dispatcher runs rules + LLM + emits telemetry,
  //                      but the orchestrator still uses the legacy
  //                      `decideSpecialists` result for fan-out. Used
  //                      to collect false-negative ground truth on
  //                      protected roles (security + logic) before
  //                      Phase 2b / 3 graduates to LLM enforcement.
  //   - "enforce_rules": SIG-227a. Dispatcher runs the RULE LAYER only
  //                      (no LLM call, ~0ms overhead) and its picks
  //                      REPLACE `router.specialists` for fan-out.
  //                      Activates the new safe-skip rules
  //                      (lockfile-only, .d.ts-only, test-files-only)
  //                      that the legacy router doesn't have. Strict
  //                      superset of the legacy router's safe-skip
  //                      coverage; fan-out only shrinks or stays equal.
  //   - "enforce" (Phase 2b/3+): full LLM enforcement. Logged but not
  //                      honored in Phase 1 / 227a.
  // See `docs/specs/2026-05-26-sig-224-dispatcher-architecture.md`.
  OPENCLAW_DYNAMIC_DISPATCHER_MODE?: string

  // When "on", PRs from a dev-style branch (dev/develop/staging/...)
  // into a release-style branch (main/master/release/...) skip the
  // pr-review job. The diff was already reviewed when the feature
  // branches went into dev; re-running on the dev→main promotion is
  // duplicate noise + duplicate API spend. pr-overview still fires
  // so the release PR still gets a summary blurb.
  OPENCLAW_PR_REVIEW_SKIP_RELEASE_BRANCHES?: string

  // SIG-437 feature flag for `@sigilix summary` (PR-body one-liner →
  // detailed PR description). "off" (default / unset) | "on". A
  // webhook/product flag read at the `pull_request` trigger gate; when
  // off the trigger never enqueues a pr-summary job → pure no-op.
  OPENCLAW_PR_SUMMARY_MODE?: string

  // SIG-439 incremental PR re-review mode. "off" (default) keeps the
  // current sampled full-review behavior byte-identical; "shadow" records
  // coverage without changing file selection; "on" reviews changed or
  // never-reviewed files only.
  OPENCLAW_INCREMENTAL_REVIEW_MODE?: string

  // SIG-104 conversational Learnings. "off" (default) keeps the feature
  // dark: commands inert, no injection. "shadow" activates the
  // @sigilix remember/forget/list commands + capture and telemeters
  // would-inject counts WITHOUT changing review prompts (bake the store).
  // "on" injects the learned per-repo guidance into specialist + synth
  // prompts. Parsed by resolveLearningsMode (@/features/learnings).
  OPENCLAW_LEARNINGS_MODE?: string

  // SDK guidance packs v1 (Greptile-partners-style vendor review context,
  // self-authored from public docs — labeled "SDK guidance", not "partner").
  // "off" (default) — no detection, no telemetry, byte-identical output.
  // "shadow" — detects matched packs from the diff and logs
  // `sdk-pack-matched {packs, prKey}`, but injects NOTHING into the prompt.
  // "on" — injects the matched packs' rules into specialist + synth prompts
  // and enables the `[sdk:<packId>]` attribution marker parse. Parsed by
  // resolveSdkPacksMode (@/src/lib/sdk-packs).
  OPENCLAW_SDK_PACKS_MODE?: string

  // Config-as-code structured rules (sigilix.json `customRules` + `disabledRules`):
  // id/scope-glob/severity/enabled structured rules, matched against the PR's
  // changed files and injected into specialist prompts, with a `[repo-rule:<id>]`
  // self-tag attribution marker (mirrors OPENCLAW_SDK_PACKS_MODE's marker scheme).
  // "off" (default/unset/any other value) — the loader is skipped entirely:
  // byte-identical review even if a repo's sigilix.json declares `customRules`.
  // "on" — matches + injects the rules and enables the attribution marker parse.
  // Binary (no shadow state) because injection is ALREADY opt-in per repo via the
  // `customRules` field's presence — there is no cross-repo blast radius to stage.
  // Parsed by resolveConfigAsCodeMode (@/src/shared/domain/config/resolve).
  OPENCLAW_CONFIG_AS_CODE_MODE?: string

  // Memory Gardener — activity-aware decay pass (Phase-1 of the dynamic-memory
  // moat), driven off the 6h cron. Three-state, DEFAULT OFF:
  //   - "off" (default / unset / any other value): the decay pass is fully
  //           inert — it returns immediately without a single KV read or GitHub
  //           call, so prod is UNAFFECTED until an operator explicitly opts in.
  //   - "shadow": scans ephemeral memories, resolves the anchoring PR's closure
  //               time, and LOGS each would-reap (`memory-decay-shadow`) — bakes
  //               the eligibility signal WITHOUT archiving anything.
  //   - "enforce": ALSO tombstones each eligible ephemeral memory into the
  //               `learnings-archive:` keyspace (archive-then-remove; never a
  //               hard delete). Durable tiers (durable_preference /
  //               architectural_fact) and legacy records are NEVER touched.
  // Bounded per tick: it covers up to MAX_LEARNINGS_KEYS_PER_TICK `learnings:`
  // keys (lexicographic, from the start — no cross-tick cursor) and a capped
  // number of PR lookups; beyond those bounds the tail is deferred to a future
  // paginating slice (logged via `memory-decay-tick-truncated`), not auto-retried.
  // Parsed by resolveMemoryDecayMode (@/features/learnings). Operator flips via
  // `wrangler secret put OPENCLAW_MEMORY_DECAY_MODE shadow`.
  OPENCLAW_MEMORY_DECAY_MODE?: string

  // Seat∪Org memory layering — Phase 1 (write side only). Two-state, DEFAULT
  // OFF:
  //   - "off" (default / unset / any other value): the org-scope mirror write
  //           never runs — no installation-id resolution, no extra KV write,
  //           the repo-scope capture path is byte-identical to today.
  //   - "on": every repo-scope learning capture (github-mention Q&A +
  //           review-memory conversational capture) is ALSO mirrored into
  //           `learnings:org:<installationId>` (installation id resolved via
  //           OPENCLAW_GITHUB_INSTALLATION_MAP, same as the rest of the
  //           GitHub-App tenant-resolution call sites). An unresolvable
  //           installation silently skips the org write — it never blocks or
  //           fails the (already-completed) repo-scope write.
  // ADDITIVE + SHADOW-SAFE: nothing reads `learnings:org:*` yet (retrieval,
  // suppression, and the Memory Gardener decay pass are untouched) — this
  // flag only controls whether the corpus starts accumulating.
  // Parsed by resolveOrgMemoryCaptureMode (@/features/learnings). Operator
  // flips via `wrangler secret put OPENCLAW_ORG_MEMORY_CAPTURE on`.
  OPENCLAW_ORG_MEMORY_CAPTURE?: string

  // Seat∪Org memory layering — Phase 2 (apply/read side). Three-state, DEFAULT
  // OFF. This gates whether PR review READS + unions the ORG-scope corpus that
  // Phase 1's OPENCLAW_ORG_MEMORY_CAPTURE writes:
  //   - "off" (default / unset / any other value): review reads repo-scope
  //           learnings ONLY — byte-identical to before this slice. No
  //           installation-id resolution, no `learnings:org:*` KV read.
  //   - "shadow": review ALSO loads the org-scope corpus (installation id
  //           resolved via OPENCLAW_GITHUB_INSTALLATION_MAP, same as the rest
  //           of the GitHub-App tenant-resolution call sites) and LOGS the
  //           delta — which org learnings WOULD widen the applied set — but the
  //           APPLIED set stays repo-only (bake the signal, output unchanged).
  //   - "on": the applied set is repo ∪ org, deduped by learning id (a repo
  //           copy wins a collision — a learning mirrored repo→org shares its
  //           id, so exactly one copy applies). An org-scope learning can then
  //           shape the review for any repo under the installation.
  // Fail-soft: an unresolvable installation or an org-store read error degrades
  // to repo-only (never blocks/delays the review, never throws).
  // Parsed by resolveOrgMemoryApplyMode (@/features/learnings). Operator flips
  // via `wrangler secret put OPENCLAW_ORG_MEMORY_APPLY on`.
  OPENCLAW_ORG_MEMORY_APPLY?: string

  // Seat∪Org memory layering — Phase 3 (CLI read side). Three-state, DEFAULT
  // OFF. This gates whether POST /v1/memory/query — the CLI's own seat-memory
  // read — ALSO unions the caller-installation's ORG-scope corpus (the same
  // corpus Phase 1/2 write and apply), independent of OPENCLAW_ORG_MEMORY_APPLY
  // (the PR-review read side above — a different call site, its own flag):
  //   - "off" (default / unset / any other value): the CLI's memory-query
  //           response is seat-memory ONLY — byte-identical to before this
  //           slice. No installation check, no `learnings:org:*` KV read.
  //   - "shadow": ALSO loads the org-scope corpus for the caller's own
  //           installation and LOGS the delta (`cli-org-memory-shadow`), but
  //           the returned results stay seat-only (bake the signal, output
  //           unchanged).
  //   - "on": the returned results are seat ∪ org, deduped by id (a seat
  //           memory wins any id collision) — a developer's fresh CLI session
  //           inherits everything the team's PR reviews taught the org.
  // ADDITIVE ONLY: never suppresses or reorders a seat-memory result, only
  // appends more. Fail-soft: the LEGACY global key (no single installation to
  // scope an org corpus to) or any org-store read error degrades to
  // seat-memory-only — never blocks/delays the response, never throws.
  // Parsed by resolveCliOrgMemoryMode (@/features/learnings). Operator flips
  // via `wrangler secret put OPENCLAW_CLI_ORG_MEMORY on`.
  OPENCLAW_CLI_ORG_MEMORY?: string

  // ARC-184 kill-switch for the review-provenance + stale-marker
  // pipeline. When set to "off", manifest writes and stale-mark
  // enqueues short-circuit. Default (unset / any other value) = on.
  // Single-flag rollback if a bug surfaces post-deploy.
  OPENCLAW_REVIEW_MANIFEST_ENABLED?: string

  // SIG-89 kill-switch for the no-op-merge skip on `synchronize`.
  // When set to "off", the webhook skips the diff-hash compare and
  // always dispatches the ensemble (the prior behavior). Default
  // (unset / any other value) = on. Lets us disable without redeploy
  // if the diff-fetch latency tax or a false-skip regression
  // surfaces. The KV writes at submit time continue regardless; the
  // skip-on-read is the only thing the kill-switch gates.
  OPENCLAW_NOOP_MERGE_SKIP_ENABLED?: string

  // ARC-189 cross-PR review-memory feature gates (default OFF for
  // both — opposite polarity from every other scanner). Retrieval
  // requires both the env flag AND `sigilix.json`
  // `reviewMemory.enabled === true`. Capture requires the env flag
  // AND (`enabled === true` OR `captureOnly === true`). See spec
  // §5.2 truth table.
  OPENCLAW_REVIEW_MEMORY_ENABLED?: string
  OPENCLAW_REVIEW_MEMORY_CAPTURE?: string
  // SIG-276 Phase 2: gates the write-time claim extractor (an extra
  // per-PR classifier round-trip). Default off; `"on"` opts in. When
  // off, findings emit markers with no `:claims:` segment (unchanged
  // pre-Phase-2 behavior) and no model call is made.
  OPENCLAW_REVIEW_MEMORY_CLAIMS?: string
  // SIG-276 Phase 3: gates the SHADOW-ONLY claim-match telemetry pass.
  // Default off; `"on"` opts in. A no-op unless OPENCLAW_REVIEW_MEMORY_ENABLED
  // AND OPENCLAW_REVIEW_MEMORY_CLAIMS are also on. NEVER changes softening —
  // it only attaches telemetry `shadowClaims` in lookup and emits the
  // `review-memory-claim-shadow` corpus the Phase-4 calibration consumes.
  OPENCLAW_REVIEW_MEMORY_CLAIM_SHADOW?: string

  // SIG-147: per-repo precision-profile rollout — `off` (default) | `shadow`
  // (compute + telemeter would-suppress, no output change) | `enforce` (drop
  // repeatedly-dismissed patterns; recall-safe, never a P0/P1). Mirrors the
  // review-memory shadow→enforce three-state flag.
  OPENCLAW_PRECISION_PROFILE_MODE?: string

  // ARC-189 one-shot deploy aid for the PROMPT_VERSION="1" → "2"
  // bump (Task 10b). When `OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE`
  // is "on", `triage-pr-stale-mark` filters the `"prompt-version"`
  // reason out of the StaleResult.reasons[] array — it does NOT skip
  // stale-marking entirely. Other drift reasons (head/base/file-list)
  // continue to fire. The companion `_SET_AT` env (UNIX seconds at
  // suppression-flag set time) drives the 24h heartbeat /
  // 72h-fail-safe ladder per spec §4.8.
  OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE?: string
  OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE_SET_AT?: string

  // ARC-190 + SIG-174: DO-orchestrated PR-review run state is now the
  // only automatic webhook path. resolveDoConfig (src/do/config.ts)
  // handles numeric retry/watchdog/history clamping.
  PR_REVIEW_RUN: DurableObjectNamespace

  // SIG-138: per-repo code/dependency graph stored in SQLite DO storage.
  // One DO instance per repo, keyed by indexNamespace(owner, repo).
  // Flag-gated: OPENCLAW_GRAPH_INDEX (write path) and
  // OPENCLAW_GRAPH_RETRIEVAL (read/expansion path). Both default off.
  REPO_GRAPH_DO: DurableObjectNamespace
  OPENCLAW_GRAPH_INDEX?: string
  OPENCLAW_GRAPH_RETRIEVAL?: string

  // SIG-286: graph-context body EXPANSION ("off" | "shadow" | "post").
  // shadow/post both COMPUTE the enriched changed-symbol context (definition /
  // caller / import-dependent bodies) and emit `graph-expansion-shadow`
  // telemetry. In PR1 `post` is RESERVED (treated like shadow — measured,
  // never injected into any prompt). Default off → fully inert.
  OPENCLAW_GRAPH_EXPANSION?: string

  // SIG-314: deterministic IDOR/BOLA floor (no-unauthorized-object-lookup).
  // off (default) | shadow (measure-only) | post (emit P2 advisory). The rule
  // always runs; this gates whether its P2-capped emits reach the synth/post.
  OPENCLAW_AUTHZ_IDOR_SCAN?: string
  // Deterministic weak-randomness floor (CWE-338, no-insecure-random-token).
  // off (default) | shadow (measure-only) | post (emit P2 advisory).
  OPENCLAW_WEAK_RANDOM_SCAN?: string
  // Deterministic open-redirect floor (CWE-601, no-open-redirect).
  // off (default) | shadow (measure-only) | post (emit P2 advisory).
  OPENCLAW_OPEN_REDIRECT_SCAN?: string
  // Deterministic SSRF floor (CWE-918, no-ssrf).
  // off (default) | shadow (measure-only) | post (emit P2 advisory).
  OPENCLAW_SSRF_SCAN?: string
  // Deterministic path-traversal floor (CWE-22, no-path-traversal).
  // off (default) | shadow (measure-only) | post (emit P2 advisory).
  OPENCLAW_PATH_TRAVERSAL_SCAN?: string
  // Deterministic SQL-injection floor (CWE-89, no-sql-injection).
  // off (default) | shadow (measure-only) | post (emit P2 advisory).
  OPENCLAW_SQL_INJECTION_SCAN?: string
  // Deterministic SSTI floor (CWE-1336, no-ssti).
  // off (default) | shadow (measure-only) | post (emit P2 advisory).
  OPENCLAW_SSTI_SCAN?: string
  // Deterministic NoSQL-injection floor (CWE-943, no-nosql-injection).
  // off (default) | shadow (measure-only) | post (emit P2 advisory).
  OPENCLAW_NOSQL_INJECTION_SCAN?: string
  // Deterministic prototype-pollution floor (CWE-1321, no-prototype-pollution).
  // off (default) | shadow (measure-only) | post (emit P2 advisory).
  OPENCLAW_PROTO_POLLUTION_SCAN?: string
  // Deterministic XXE floor (CWE-611, no-xxe).
  // off (default) | shadow (measure-only) | post (emit P2 advisory).
  OPENCLAW_XXE_SCAN?: string
  /** Lane D: ingest repo AI-instruction files (CLAUDE.md/…) as advisory review guidance. Default on; "off" disables. */
  OPENCLAW_INGEST_AI_INSTRUCTIONS?: string

  // SIG-317: synth verdict-truncation recovery. off (default) | shadow (log the
  // recoverable count) | on (apply). Recovers findings the synth marked KEPT in
  // provenance but truncated out of verdict.findings on target-rich PRs.
  OPENCLAW_SYNTH_RECOVERY?: string

  // SIG-484: lower the full-coverage synth source floor 4→2 + raise the per-verdict
  // synth-input cap (bounded). off (default) | shadow (log the would-restore delta) |
  // on (apply). Recovers score 2-3 source findings the synth thins on dense PRs.
  OPENCLAW_SYNTH_SOURCE_FLOOR_LOW?: string

  // SIG-487: run a 2nd (recall-suffixed) security pass + union its findings. off
  // (default) | shadow (telemeter overlap/new/error only) | on (merge pre-synth).
  OPENCLAW_SECURITY_KUNION?: string

  // SIG-488 (recall #5): demote-instead-of-hard-drop for sev>=4 findings at the
  // vague-prefix / uncited-testing gates. off (default) | shadow (count would-saves)
  // | on (demote sev>=4 to a P2 note instead of dropping; low-sev still drops).
  OPENCLAW_GATE_DEMOTE_HIGH_SEV?: string

  // SIG-317 step 6 Part A: deterministic AST-emit injection floor. off (default)
  // | shadow (log what WOULD inject) | on (inject). Force-surfaces an
  // `emitWhenUnmatched` (warning/info) AST finding the synth crowded out of its
  // verdict — the proven subtle needle (cents-as-dollars, enum drift). Cites the
  // astFindingId so it flows through the post-synth gates; P2/P3-capped (never a
  // P0/P1). Recall-positive backstop to the synth's "emit it yourself" prompt.
  OPENCLAW_AST_EMIT_FLOOR?: string

  // SIG-317 Part 4b: cross-function asymmetry hints for the logic specialist.
  // off (default) | shadow (log the hint count) | on (inject into the logic
  // prompt). A FACT (mutator bypasses an aggregation helper used elsewhere) for
  // the model to judge — nudges the specialist, so shadow-first.
  OPENCLAW_ASYMMETRY_HINTS?: string

  // SIG-317 Part 4b-v2: TOCTOU / check-then-act race hints for the logic
  // specialist. off (default) | shadow (log the hint count) | on (inject). A
  // FACT (SELECT-check then separate relative UPDATE with no atomic guard) for
  // the model to judge — nudges the specialist, so shadow-first.
  OPENCLAW_TOCTOU_HINTS?: string

  // SIG-161: confidence-threshold verdict gate. Three-state rollout
  //   "off"     — bypassed; legacy `chooseReviewEvent` decides (default).
  //   "shadow"  — `chooseReviewEventWithGate` runs but legacy verdict ships;
  //               divergence logged to ValidationMetricsDO.
  //   "enforce" — `chooseReviewEventWithGate` decides the posted verdict.
  // The threshold + model artifact live in KV (config:gate-threshold:v1 /
  // config:gate-model:v1) so retunes don't require a redeploy. See
  // .claude/research/sig-161-labeling/DESIGN.md §9.
  OPENCLAW_GATE?: string

  // SIG-119: single global DO holding rolling per-gate validator shadow
  // telemetry (would-drop / kept counts, daily buckets). Read via the
  // authenticated GET /metrics/validation endpoint.
  VALIDATION_METRICS_DO: DurableObjectNamespace
  // Shared-secret bearer token guarding /metrics/validation AND /metrics/graph.
  // Unset → both endpoints return 503. Set via
  // `wrangler secret put OPENCLAW_VALIDATION_METRICS_TOKEN <token>`.
  OPENCLAW_VALIDATION_METRICS_TOKEN?: string

  // SIG-304 Phase 2: shared-secret bearer for POST /v1/review (the hosted thin
  // client). Unset → the endpoint returns 503 (inert). Set via
  // `wrangler secret put OPENCLAW_SIGILIX_API_KEY <token>` (openssl rand -base64 32).
  OPENCLAW_SIGILIX_API_KEY?: string

  // SIG-304 Phase 2.4: coarse endpoint-wide daily request ceiling for POST
  // /v1/review (cost/abuse guard for the grounded path). Numeric string; unset →
  // a built-in default. A global KV counter (`v1review:count:<YYYY-MM-DD>`), not
  // per-key metering — once the day's count hits the limit the endpoint returns 429.
  OPENCLAW_SIGILIX_API_DAILY_LIMIT?: string

  // SIG-545: OIDC issuer URI for the Boreas CLI gateway — the exact worker origin
  // the GCP WIF provider was created against (assertion JWT `iss` + /.well-known).
  // Unset → boreas chat/discovery 503. `wrangler secret put OPENCLAW_GATEWAY_ISSUER`.
  OPENCLAW_GATEWAY_ISSUER?: string

  // Same-site public origin (api.sigilix.ai) for the Linear OAuth redirect_uri so
  // the callback keeps the portal cookie; see wrangler.toml. Not the gateway iss.
  SIGILIX_LINEAR_REDIRECT_ORIGIN?: string

  // SIG-545: coarse endpoint-wide daily request ceiling for POST
  // /v1/boreas/chat/completions (cost/abuse guard — every admitted request mints a
  // GCP token + bills a Vertex call). Numeric string; unset → a built-in default. A
  // global KV counter (`boreas:count:<YYYY-MM-DD>`), not per-key metering — once the
  // day's count hits the limit the endpoint returns 429. Mirrors
  // OPENCLAW_SIGILIX_API_DAILY_LIMIT (the /v1/review ceiling above).
  OPENCLAW_BOREAS_DAILY_LIMIT?: string

  // SIG-545: coarse daily request ceiling for POST /v1/pyroeis/chat/completions. Same
  // shape as OPENCLAW_BOREAS_DAILY_LIMIT above — a global KV counter
  // (`pyroeis:count:<YYYY-MM-DD>`), unset → a built-in default, 429 once the day hits it.
  OPENCLAW_PYROEIS_DAILY_LIMIT?: string

  // Forced Vertex model id for the Pyroeis route (POST /v1/pyroeis/chat/completions).
  // Overrides the built-in DEFAULT_PYROEIS_MODEL (Gemini 3.5 Flash on Vertex AI —
  // `google/gemini-3.5-flash`, served over the same OpenAI-compat chat/completions
  // endpoint as the other legs, so no request/response adapter). Trimmed; blank → the
  // built-in default. Exists because the exact Gemini 3.5 Flash version string (e.g. a
  // `-001`/date suffix) can't be confirmed without live Vertex, so correcting it is a
  // config flip, not a code change. Unlike Boreas/Astraeus (hard-pinned constants), the
  // Pyroeis model is env-overridable for exactly this reason.
  SIGILIX_PYROEIS_MODEL?: string

  // SIG-545: coarse daily request ceiling for POST /v1/astraeus/chat/completions. Same
  // shape as OPENCLAW_BOREAS_DAILY_LIMIT above — a global KV counter
  // (`astraeus:count:<YYYY-MM-DD>`), unset → a built-in default, 429 once the day hits it.
  OPENCLAW_ASTRAEUS_DAILY_LIMIT?: string

  // #158 failover chain, leg 2 (Ollama Turbo). Per-model override of the Turbo
  // fallback model id substituted when the Vertex leg fails before the first
  // response byte (connect error / timeout / 5xx / 429). Unset -> the route's
  // built-in default (Boreas/Astraeus) or no Turbo leg at all (Pyroeis has no
  // built-in default -- see constants.ts). Requires OLLAMA_API_KEY to actually
  // be configured; the leg is skipped (not attempted) without it.
  OPENCLAW_BOREAS_FALLBACK_TURBO_MODEL?: string
  // Same shape as OPENCLAW_BOREAS_FALLBACK_TURBO_MODEL above. NO built-in
  // default -- Pyroeis's Vertex model (Gemini 3.5 Flash) is Vertex-only, with no
  // Gemini tag on Ollama Turbo, so guessing one risks a silent wrong-model
  // swap. Unset -> Pyroeis has no Turbo leg; a Vertex failure surfaces
  // directly (or falls to Bedrock, once configured).
  OPENCLAW_PYROEIS_FALLBACK_TURBO_MODEL?: string
  // Same shape as OPENCLAW_BOREAS_FALLBACK_TURBO_MODEL above.
  OPENCLAW_ASTRAEUS_FALLBACK_TURBO_MODEL?: string

  // The AWS + Bedrock-ensemble vars live in the composed `AwsBedrockEnv`
  // sub-interface (`./env-aws-bedrock`) that `Env` extends — the per-feature
  // split the class-module allowlist note names as this file's real fix.

  // POST /v1/verify (sealed pure-logic verification oracle) — coarse endpoint-wide
  // daily request ceiling (it burns QuickJS CPU). Numeric string; unset → a built-in
  // default. A global KV counter (`v1verify:count:<YYYY-MM-DD>`), not per-key metering —
  // once the day's count hits the limit the endpoint returns 429. Auth reuses
  // OPENCLAW_SIGILIX_API_KEY (the shared agent bearer); unset → /v1/verify returns 503.
  OPENCLAW_SIGILIX_VERIFY_DAILY_LIMIT?: string

  // SIG-507 fleet intelligence: salt for the distinct-tenant counter's tenant-hashing (defense-in-
  // depth — the linear-counting bitmap stores no identity regardless). Set via
  // `wrangler secret put OPENCLAW_FLEET_SALT <token>`; unset → a built-in default salt.
  OPENCLAW_FLEET_SALT?: string

  // SIG-152: single global DO holding rolling daily aggregates of the SIG-138
  // `pr-review-graph-retrieval` shadow sample. Read via GET /metrics/graph.
  GRAPH_METRICS_DO: DurableObjectNamespace

  // SIG-184 PR 5b: single global DO holding rolling runner-evidence presence
  // counters (verified / evidence-pending / runner-absent × reason, + per-repo
  // latest state). Read via the authenticated GET /metrics/runner-evidence
  // endpoint (shares OPENCLAW_VALIDATION_METRICS_TOKEN).
  RUNNER_EVIDENCE_METRICS_DO: DurableObjectNamespace

  // SIG-107: single global DO holding accepted runner scan-manifest telemetry
  // by deterministic tool/status. Read via GET /metrics/runner-tools (shares
  // OPENCLAW_VALIDATION_METRICS_TOKEN). Telemetry-only; never affects ingest.
  RUNNER_TOOL_METRICS_DO: DurableObjectNamespace

  // SIG-285 PR 2: single global DO holding rolling verification-by-execution
  // verdict counters (confirmed / refuted / inconclusive / no-check × category).
  // Read via GET /metrics/verification (shares OPENCLAW_VALIDATION_METRICS_TOKEN).
  VERIFICATION_METRICS_DO: DurableObjectNamespace

  // SIG-286 PR2.5: single global DO holding rolling graph-context-expansion
  // shadow aggregates (netNewTokens histogram → median, cross-file rates, fetch
  // cost). Read via GET /metrics/graph-expansion (shares the metrics token) —
  // the readable CONTROL-vs-TREATMENT number the PR3 inject GO/KILL keys off.
  GRAPH_EXPANSION_METRICS_DO: DurableObjectNamespace

  // ─── SIG-298: deep web research engine ─────────────────────────────
  // DeepResearchDO — one DO instance per research run (crypto-random id). Owns
  // the run loop + the buffered SSE transcript. See src/do/deep-research/.
  DEEP_RESEARCH: DurableObjectNamespace
  // Termination quad + budgets (all clamped in config.ts; defaults in parens).
  OPENCLAW_RESEARCH_MAX_ROUNDS?: string // hard round ceiling (8)
  OPENCLAW_RESEARCH_MAX_TIME_MS?: string // wall-clock ceiling ms (300000)
  OPENCLAW_RESEARCH_MIN_ROUNDS?: string // floor before stop-check/empty-kill fire (2)
  OPENCLAW_RESEARCH_MAX_EMPTY_ROUNDS?: string // consecutive empty rounds that kill (2)
  OPENCLAW_RESEARCH_MAX_QUERIES_PER_ROUND?: string // (4)
  OPENCLAW_RESEARCH_MAX_PAGES_PER_ROUND?: string // (5)
  OPENCLAW_RESEARCH_MAX_PARALLEL_FETCHES?: string // (3)
  OPENCLAW_RESEARCH_TOKEN_BUDGET?: string // run-level token cap (250000)
  OPENCLAW_RESEARCH_CLEANUP_AFTER_MS?: string // DO cleanup-alarm horizon (3600000)
  // Per-tier heavy-role model override (OpenRouter catalog ids). Deep research
  // routes tier models through OpenRouter; unset → config.ts TIER_MODELS defaults.
  SIGILIX_DEEPRESEARCH_BOREAS_MODEL?: string
  SIGILIX_DEEPRESEARCH_PYROEIS_MODEL?: string
  SIGILIX_DEEPRESEARCH_ASTRAEUS_MODEL?: string
  SIGILIX_SKILLS_MODE?: string
  // Per-role model overrides (Astraeus chain for reasoning roles; cheap Boreas
  // tier for classify/extract). Unset → the defaults in config.ts.
  OPENCLAW_RESEARCH_PLANNER_MODEL?: string
  OPENCLAW_RESEARCH_SYNTHESIS_MODEL?: string
  OPENCLAW_RESEARCH_STOP_CHECK_MODEL?: string
  OPENCLAW_RESEARCH_FINAL_REPORT_MODEL?: string
  OPENCLAW_RESEARCH_CLASSIFY_MODEL?: string
  OPENCLAW_RESEARCH_EXTRACT_MODEL?: string
  // Search-provider keys — the fallback chain (first CONFIGURED provider in the
  // resolved chain serves each query). Unset providers are skipped; when ALL are
  // unset the engine degrades gracefully to a model-only answer (no error event).
  // OPENCLAW_SEARCH_CHAIN: comma-separated provider order; unknown keys are
  // skipped (logged). Default: "exa,tavily,brave,selfhost,google-pse". "serper"
  // is not in the default chain but its adapter stays available as an opt-in
  // entry. The self-hosted SearXNG/agent-search leg is an overflow lane.
  OPENCLAW_SEARCH_CHAIN?: string
  OPENCLAW_EXA_API_KEY?: string
  OPENCLAW_SELFHOST_SEARCH_URL?: string
  OPENCLAW_SELFHOST_SEARCH_TOKEN?: string
  // sig-selfhost-search: Sigilix-first names for the self-hosted (SearXNG) search
  // leg. NEW config, so the canonical SIGILIX_ name is declared explicitly here
  // (search.ts reads `env.SIGILIX_SELFHOST_SEARCH_URL ?? env.OPENCLAW_SELFHOST_SEARCH_URL`).
  // The OPENCLAW_ names stay as the fallback for continuity with the normalizeEnv
  // shim / any legacy secret. `_URL` is the base origin of the SearXNG instance
  // (e.g. https://search.sigilix.ai); `_TOKEN` is an OPTIONAL bearer the adapter
  // sends as `Authorization: Bearer <token>` (enforced by a proxy in front — SearXNG
  // core does not check it).
  SIGILIX_SELFHOST_SEARCH_URL?: string
  SIGILIX_SELFHOST_SEARCH_TOKEN?: string
  OPENCLAW_TAVILY_API_KEY?: string
  OPENCLAW_BRAVE_API_KEY?: string
  OPENCLAW_SERPER_API_KEY?: string
  OPENCLAW_GOOGLE_PSE_KEY?: string
  OPENCLAW_GOOGLE_PSE_CX?: string

  // SIG-184: runner-evidence ingest (POST /runner/ingest). The GitHub OIDC token
  // IS the auth; these pin what a valid token must attest. Both come from the
  // Sigilix runner repo — until set, the ingest route returns 503.
  //   OPENCLAW_RUNNER_OIDC_AUDIENCE — the `aud` the runner mints its token with.
  //   OPENCLAW_RUNNER_WORKFLOW_REF  — Sigilix's pinned reusable-workflow
  //                                   `owner/repo/path` (no `@ref`).
  OPENCLAW_RUNNER_OIDC_AUDIENCE?: string
  OPENCLAW_RUNNER_WORKFLOW_REF?: string
  // SIG-285 runner-execution (outbound): on-demand workflow_dispatch of a
  // per-finding deterministic check. off (default) | shadow (would-dispatch
  // telemetry) | on (actually dispatch). Needs the App's Actions:write + a
  // caller workflow in the target repo. Dark default — dispatching is a write
  // action; wired into the review flow in a follow-up.
  OPENCLAW_RUNNER_DISPATCH_MODE?: string
  // SIG-184 PR 3: consumption rollout posture — "off" (default) | "shadow"
  // (look up + telemetry, review unchanged) | "post" (use the verified receipt's
  // SARIF + render the verified/pending/absent state).
  OPENCLAW_RUNNER_EVIDENCE_MODE?: string
  // SIG-285 PR 1: verification-by-execution rollout posture — "off" (default) |
  // "shadow" (worker-native line-anchored re-check of score>=4 logic/security
  // findings + verdict telemetry, review UNCHANGED) | "enforce" (reserved; PR 1
  // treats it as shadow — the REFUTED-only demotion lands in PR 4).
  OPENCLAW_VERIFICATION_MODE?: string
  // SIG-285 re-anchor (inline-first): "on" applies the re-anchor MUTATION (move a
  // refuted inline finding to its correct diff line) when verification is enforce.
  // Default off → inert (re-anchor stays shadow-measured by PR1).
  OPENCLAW_VERIFICATION_REANCHOR?: string
  // SIG-285 v2 PR1: receipt-join verification mode. "off" (default) skips it;
  // "shadow" joins each score>=4 security finding (with a resolvable evidenceId)
  // to the verified SIG-184 runner receipt's HEAD SARIF — CONFIRMED if the same
  // rule still fires there, INCONCLUSIVE otherwise (NEVER refuted) — and
  // telemeters the verdict (event:verification-receiptjoin) so the refutable-
  // eligible fraction is measurable before any demote path. NO new GitHub perm.
  // "enforce" reserved (demotion is PR4/5). Review UNCHANGED in all modes.
  OPENCLAW_RECEIPTJOIN_MODE?: string
  // SIG-476 PR2: in-worker self-confirmation gate — off | shadow | on (default off).
  // `shadow` runs the PR-1 `confirmFindingAgainstInWorkerAst` join over the submitted
  // findings and MEASURES the confirmed/uplift fractions (the `selfconfirm` corpus on
  // VerificationMetricsDO, read at GET /metrics/verification) WITHOUT mutating any tier
  // — the GO/NO-GO deciding whether `deterministic-confirmed` earns a distinct pill
  // (PR3) or stays a GROUNDED sub-state. `on` also annotates a confirmed finding with
  // the `deterministic-confirmed` trust signal. NO render change in any mode (PR3).
  OPENCLAW_SELFCONFIRM_MODE?: string
  // SIG-477 PR-1: execution-sandbox eligibility gate — "off" (default) | "shadow" |
  // "on". `shadow`/`on` run the PURE `isReproducibleEligible` gate over the submitted
  // findings and MEASURE the eligible fraction (the `reproduce_eligibility` corpus on
  // VerificationMetricsDO, read at GET /metrics/verification) — the GO/NO-GO deciding
  // whether the reproduce engine (PR-2+) is worth building. DARK: NO execution, NO
  // render, NO tier mutation in ANY mode (even `on` only measures; the annotate comes
  // in PR-5 with the engine).
  OPENCLAW_REPRODUCE_MODE?: string
  // SIG Trust Ledger v0: off | shadow | on. `off` (default) attaches per-finding
  // trust metadata in-memory but records no telemetry + renders nothing. `shadow`
  // also records the tier distribution (TRUSTLEDGER_CATEGORY on VerificationMetricsDO,
  // read at GET /metrics/verification). `on` also renders the Trust Summary and
  // per-finding VERIFIED/GROUNDED/MODEL pills.
  OPENCLAW_TRUST_LEDGER?: string
  // SIG-318 (golden-output safety harness): "on" makes the two pure ensemble
  // seams (`validateForSubmission` + `buildReviewSubmissionWithMetadata`) emit
  // a `[[GOLDEN:<stage>]]` log line carrying the encoded {args/input, output}
  // so a fixture can be lifted from the logs for byte-identical parity replay.
  // Unset / any other value (the default everywhere incl. prod) → the capture
  // hooks are an immediate no-op (byte-identical behavior). Never "on" in prod.
  OPENCLAW_GOLDEN_CAPTURE?: string
  // SIG-184: per-repo-sharded SQLite DO enforcing single-use of a runner receipt
  // (repository_id, sha, run_id, run_attempt) + holding the defensible record.
  RUNNER_RECEIPT_DO: DurableObjectNamespace

  // SIG-455: per-tenant concurrency gate (KV-backed DO storage). One instance per
  // tenant; gates pr-review fan-out to SIGILIX_TENANT_CONCURRENCY_CAP per tenant.
  TENANT_CONCURRENCY: DurableObjectNamespace

  // SIG-455 PR B: per-provider backpressure cooldown (SQLite DO storage). One
  // instance per provider slug; flag-gated behind SIGILIX_PROVIDER_COOLDOWN_MODE.
  PROVIDER_COOLDOWN: DurableObjectNamespace

  // SIG-144 (Linear unification slice 1): LinearTokenBroker — owns the Linear agent
  // token lifecycle + serializes refresh across isolates. Singleton; INERT this slice.
  LINEAR_TOKEN_BROKER: DurableObjectNamespace

  // sig-mcp-connections-p1: McpConnectionsAgent — one DO instance per seat
  // (idFromName("session:<githubUserId>") or "tenant:<installationId>"), wrapping
  // the Cloudflare `agents` SDK's MCPClientManager. Owns connect (incl. OAuth),
  // token storage (the SDK's own SQLite), list, and disconnect for any
  // user-supplied MCP server URL. See src/do/mcp/.
  MCP_CONNECTIONS: DurableObjectNamespace

  // SIG-156: shared-secret bearer token for the privileged admin endpoints
  // (POST /admin/index-repo manual (re)index trigger / backfill). Unset → those
  // routes return 503. Set via `wrangler secret put OPENCLAW_ADMIN_TOKEN`.
  OPENCLAW_ADMIN_TOKEN?: string

  // sig-admin-metrics: dedicated server-to-server shared secret for the STAFF-ONLY
  // aggregate endpoint GET /v1/admin/metrics (powers admin.sigilix.ai). SEPARATE
  // from OPENCLAW_ADMIN_TOKEN so the admin dashboard's read-only aggregate access
  // and the operator index/migration tools rotate independently. FAIL-CLOSED: unset
  // → the route returns 503 (never an open dashboard); a present-but-wrong bearer →
  // 401 via a constant-time compare (requireBearerToken). Only the admin site's
  // SERVER routes ever hold this — it is never shipped to a browser. Set via
  // `wrangler secret put ADMIN_API_SECRET`.
  ADMIN_API_SECRET?: string
  OPENCLAW_GRAPH_RPC_TIMEOUT_MS?: string
  /** SIG-392: recall-eliciting logic-specialist prompt — "on" appends the recall
   *  directive to the logic prompt (~6→16/20 logic recall on the dense fixture).
   *  Default off. Precision is the downstream gates' job. */
  OPENCLAW_LOGIC_RECALL_MODE?: string
  /** SIG-392 (security lane): recall-eliciting security-specialist prompt — "on"
   *  appends the security recall directive (targets the b16 list-authz + b20
   *  HMAC-reserialized frontier). Default off. Precision is the gates' job. */
  OPENCLAW_SECURITY_RECALL_MODE?: string
  /** SIG-399: reasoning-process directive for the logic specialist — "on" appends
   *  the LOGIC_REASONING_SUFFIX (enumerate-then-judge / verify-the-computed-value /
   *  uncertainty→low-score) on top of any recall directive. Distinct from the
   *  SIG-287 reasoning-EFFORT harness below (that gates the model `think:` level;
   *  this gates the PROMPT text). Default off; validated on o3 (floor +3 net recall,
   *  0 FP) — enabling on another model needs its own floor check. */
  OPENCLAW_LOGIC_REASONING_PROMPT_MODE?: string
  /** SIG-287 (reasoning-on harness): master switch for per-role DeepSeek
   *  reasoning — "on" enables the `reasoningByRole` map (built from
   *  `OPENCLAW_REASONING_ROLES` + `OPENCLAW_REASONING_LEVEL`); anything else
   *  (default) leaves it EMPTY → every call stays `think:false`, byte-identical
   *  to today. Rolled out per-role + measured, never a global flip. */
  OPENCLAW_REASONING_MODE?: string
  /** SIG-287: comma-separated specialist roles to enable bounded reasoning on
   *  when `OPENCLAW_REASONING_MODE === "on"` (e.g. "security" then "security,tests").
   *  Empty/unset with mode on → no roles (still default-off in effect). Unknown
   *  tokens are ignored. SIG-450: a token may carry a per-role level override
   *  `role:level` (e.g. "logic:high,tests") so one role runs at a different effort
   *  than the shared default; a bare role uses `OPENCLAW_REASONING_LEVEL`. An
   *  invalid per-role level drops that token (no silent downgrade). */
  OPENCLAW_REASONING_ROLES?: string
  /** SIG-287: DEFAULT bounded reasoning level for roles listed WITHOUT a per-role
   *  `role:level` override — "high" (default) | "medium" | "low". Never `think:true`
   *  (unbounded). An explicit-but-invalid value disables reasoning entirely (off). */
  OPENCLAW_REASONING_LEVEL?: string
  /** SIG-393: region re-sweep mode — "off" (default) | "shadow" | "on". */
  OPENCLAW_RESWEEP_MODE?: string
  /** SIG-393: max regions per re-sweep (default 6). */
  OPENCLAW_RESWEEP_MAX_REGIONS?: string
  /** Giant-PR total-context ceiling in estimated INPUT tokens across the whole
   *  review (default 300_000). Bounds the SIG-418 multi-batch spillover expansion:
   *  batch[0] is always reviewed; spillover halts once the cumulative estimated
   *  input would cross this. New var → SIGILIX_-named (normalizeEnv mirrors it). */
  SIGILIX_MAX_REVIEW_CONTEXT_TOKENS?: string
  /** SIG-369(b): route the SECOND-PASS recall phases' LOGIC re-runs
   *  (SIG-395 invariant-lens, SIG-393 resweep) to a cheaper strong reasoner
   *  (`deepseek/deepseek-v4-pro`) instead of the primary logic model — "off"
   *  (default) | "on". Cost lever only; the primary logic specialist is never
   *  affected. (Still a win post-SIG-450: v4-pro is cheaper than Kimi K2.7 too.)
   *  Default off is byte-identical (those passes stay on o3). A live recall
   *  gauge gates the flip; never enable here without it. */
  OPENCLAW_SECONDPASS_REASONER_MODE?: string
  /** SIG-417: the dark projected-cost governor (TRIM). "on" enables trimming
   *  low-risk files when the projection exceeds the ceiling; default off →
   *  capture + projection telemetry only, review byte-identical. Trim is
   *  recall-NEGATIVE (drops deterministic + secret scans on trimmed files), so
   *  it is a founder-set emergency lever, never default behavior. */
  OPENCLAW_COST_GOVERNOR_ENABLED?: string
  /** SIG-417: founder-set per-PR projected-cost ceiling in USD (parseFloat).
   *  Absent → no ceiling → never trims even when enabled. */
  OPENCLAW_COST_GOVERNOR_CEILING_USD?: string
  /** SIG-417: floor — never trim below this many reviewed files (default 1). */
  OPENCLAW_COST_GOVERNOR_MIN_REVIEWED_FILES?: string
  /** SIG-417: per-call fixed-overhead token estimate for the projection
   *  (system prompt + retrieval + output budget; default 4000). */
  OPENCLAW_COST_GOVERNOR_PER_CALL_OVERHEAD_TOKENS_EST?: string
  /** SIG-418 Phase 2 (Design B′): in-invocation multi-batch review mode —
   *  "off" (default) | "shadow" | "on". DARK in PR 1 (pure infra only, no
   *  orchestrator wiring), so any value is currently a no-op on review behavior. */
  OPENCLAW_REVIEW_MULTIBATCH_MODE?: string
  /** SIG-395: invariant lens mode — "off" (default) | "shadow" | "on". */
  OPENCLAW_INVARIANT_LENS_MODE?: string
  /** SIG-400/SIG-401: "blocking" (default) | "shadow-background" |
   *  "pending-check-amendment". The amendment contract is fail-closed until
   *  the deep-lane follow-up owns a merge-blocking check signal. */
  OPENCLAW_INVARIANT_LENS_RECALL_CONTRACT?: string
  OPENCLAW_PR_REVIEW_DO_MAX_RETRIES?: string
  OPENCLAW_PR_REVIEW_DO_WATCHDOG_MS?: string
  // SIG-329: max tolerated gap (ms) between runner heartbeats before the
  // DO declares an in-flight attempt dead and retries. Decouples
  // dead-consumer detection from the watchdog backstop.
  OPENCLAW_PR_REVIEW_DO_LIVENESS_MS?: string
  OPENCLAW_PR_REVIEW_DO_HISTORY_LIMIT?: string

  // SIG-108: security-finding evidence gate mode. "shadow" (default;
  // any value other than "enforce") counts + telemeters what the gate
  // WOULD drop without dropping; "enforce" actually drops sev>=4
  // security findings whose evidence is fabricated / non-linking /
  // absent (after auto-enrich fails). Default OFF-by-effect (shadow)
  // so the gate ships dark and the drop rate is observable before
  // enforcement. Operator flips via
  // `wrangler secret put OPENCLAW_SECURITY_VALIDATOR_MODE enforce`.
  OPENCLAW_SECURITY_VALIDATOR_MODE?: string

  // SIG-392: "on" → at the SIG-108 evidence gate's demote branch, a failing
  // sev>=4 security finding carrying a concrete mechanism (non-empty
  // failureExample) is RECATEGORIZED to `logic` and kept inline instead of
  // body-demoted (the security-shaped-logic-bug class — key collisions,
  // authz-by-construction — that can never have scanner evidence).
  // Anything else → off (byte-identical demote behavior).
  OPENCLAW_SECURITY_RECLASS?: string

  // SIG-111 / SIG-245: tests-finding specificity gate mode. "shadow"
  // (default; any value other than "enforce") counts + telemeters what
  // the gate WOULD demote without acting; "enforce" DEMOTES sev>=4
  // `category: "testing"` findings whose missing-coverage claim is
  // uncited or whose insufficient-test claim names no concrete
  // source/API/branch to a NON-blocking body note (FN-safe, still
  // visible — NOT dropped; score capped below the score>=4
  // REQUEST_CHANGES floor so a coverage over-fire never gates a PR).
  // This gate is
  // false-negative-sensitive, so the would-demote rate was observed in
  // shadow before enforcement. Set as a `[vars]` entry in wrangler.toml
  // (= "enforce"), NOT a `wrangler secret` — a stale same-name secret
  // would shadow the var; do not `wrangler secret put` this flag.
  OPENCLAW_TESTS_VALIDATOR_MODE?: string

  // SIG-333: CI-triage inline-suggestion mode. "shadow" (default; any
  // value other than "enforce") computes + telemeters the would-post
  // anchorable/un-anchorable counts WITHOUT posting inline; "enforce"
  // posts apply-able `suggestion` review comments on CI-failure fixes.
  OPENCLAW_CI_SUGGESTIONS_MODE?: string

  // CI-triage → review-synth (grounded inline). "off" (default; any value
  // other than the literal "shadow"/"enforce") leaves the legacy standalone
  // CI-triage path unchanged; "shadow" runs the synth + ground + dedup pass
  // and telemeters the would-post grounded inline findings without posting;
  // "enforce" posts the grounded inline findings and suppresses the legacy
  // sticky + SIG-333 suggestions. Parsed by `parseCiTriageSynthMode`
  // (ci-triage-synth.ts). Ships dark (off) — PR 1 wires nothing.
  OPENCLAW_CI_TRIAGE_SYNTH_MODE?: string

  // SIG-426: when "true", the CI-triage-synth anchored-but-uncorroborated
  // bucket is HARD-WITHHELD instead of hedged-inline. DEFAULT (any other value)
  // is hedged-inline — the uncorroborated finding is surfaced with one honest
  // hedge line, NOT dropped (recall-safety). The shadow window's true/false
  // rate on that bucket decides whether to flip this on. Read in
  // `ci-triage-synth-run.ts`.
  OPENCLAW_CI_TRIAGE_SYNTH_HARD_WITHHOLD?: string

  // SIG-433: when "on", the CI-triage-synth applies a DETERMINISTIC anchor remap
  // — a log-grounded finding the model anchored to a witness/header/declaration
  // line is re-homed to the changed SOURCE line (the assignment/return/property
  // of an identifier the finding names) that PRODUCES the failure, so a correct
  // diagnosis posts on (and is caught at) the buggy line instead of being
  // withheld or posted on the wrong line. DEFAULT OFF (any other value): enforce
  // is LIVE, so the remap ships dark until the eval proves the catch lift. Only
  // ever MOVES an anchor among real changed `+`-lines (never fabricates); a wrong
  // remap = a wrong inline comment, so it's biased to no-op on any ambiguity.
  // Parsed by `parseCiTriageAnchorRemap`; read in `ci-triage-synth-run.ts`.
  OPENCLAW_CI_TRIAGE_ANCHOR_REMAP?: string

  // SIG-436: when "on", the MAIN PR-review inline submission applies a
  // DETERMINISTIC anchor-precision pass — a finding the model anchored to the
  // `// comment` line directly ABOVE the bug (a whole-line comment, which the
  // base substantive-anchor walk treats as substantive) is re-homed forward onto
  // the buggy code statement the comment describes. DEFAULT OFF (any other
  // value): inline anchoring is a LIVE surface and a benchmark runs on prod, so
  // this ships dark until the K=12 exactness eval proves the lift. Only ever
  // re-homes among real changed `+`-lines (never fabricates); no substantive code
  // line in window → the finding body-demotes (surfaced, never dropped), never a
  // wrong-line anchor. Parsed in `parseEnsembleConfig` → `flags.anchorPrecision`;
  // threaded into the render layer via `buildReviewSubmissionWithMetadata`.
  OPENCLAW_ANCHOR_PRECISION?: string

  // SIG-109: logic-finding evidence gate mode. "shadow" (default; any
  // value other than "enforce") counts + telemeters what the gate WOULD
  // drop without dropping; "enforce" actually drops sev>=4 logic findings
  // that are unanchored (not on a changed path, or quoting no concrete
  // code token on an added line, and unbacked by any co-located AST hit).
  // Default OFF-by-effect (shadow) so the gate ships dark — this gate is
  // false-negative-sensitive (logic bugs are LLM-found with no
  // deterministic backing), so the would-drop rate is observed before
  // enforcement. Operator flips via
  // `wrangler secret put OPENCLAW_LOGIC_VALIDATOR_MODE enforce`.
  OPENCLAW_LOGIC_VALIDATOR_MODE?: string

  // SIG-308: logic-refutation backstop mode. "off" | "shadow" | "enforce".
  // Flags a sev>=4 logic finding that never showed it survives refutation
  // (no `independentAssessment`) — the self-refuting-finding shape. Ships
  // dark ("shadow" in wrangler) because it is the only recall guard for the
  // self-generated logic-candidate stream and initially over-flags legit
  // findings that simply lack a rationale; the would-flag rate is observed
  // (while the Phase 1 prompt trains the model to fill it) before any flip
  // via `wrangler secret put OPENCLAW_LOGIC_REFUTATION_MODE enforce`.
  OPENCLAW_LOGIC_REFUTATION_MODE?: string
  // SIG-328/SIG-334: logic-claim refutation gate. off | shadow (would-drop
  // telemetry) | enforce (drop a supported logic claim shape that is PROVABLY
  // false against the cited AST). Fails open; ships dark ("shadow").
  OPENCLAW_LOGIC_CLAIM_REFUTATION_MODE?: string
  // SIG-392: reason-scoped enforce allowlist (comma list of LogicClaimDropReason).
  // UNSET → `enforce` drops EVERY shape (legacy). SET → in `enforce` ONLY the
  // listed reasons drop; the rest stay shadow. Lets balance-sign enforce alone.
  OPENCLAW_LOGIC_CLAIM_REFUTATION_ENFORCE_REASONS?: string

  // SIG-325: generalized refutation-survival gate mode. "off" (default in code;
  // "shadow" in wrangler) extends the SIG-308 refute-first discipline to
  // self-originated findings on OTHER lenses — a security CWE claim with no
  // resolving manifest evidenceId, or a performance finding with no co-located
  // AST hit: a sev>=4 such finding lacking an `independentAssessment` mechanism
  // rationale is flagged. "shadow" counts + telemeters the would-demote;
  // "enforce" demotes to the review body. Set in wrangler.toml [vars]
  // (reviewable, version-controlled), matching the TESTS validator-mode flag —
  // do NOT `wrangler secret put` it, or the secret shadows the var.
  OPENCLAW_REFUTATION_SURVIVAL_MODE?: string

  // SIG-110: perf-finding evidence gate mode. "shadow" (default) counts +
  // telemeters the would-drop; "enforce" drops unanchored sev>=4 perf
  // findings. Operator flips via
  // `wrangler secret put OPENCLAW_PERF_VALIDATOR_MODE enforce`.
  OPENCLAW_PERF_VALIDATOR_MODE?: string

  // SIG-281 PR C (Rec 4): inline-grounding gate mode. "shadow" (default)
  // counts + telemeters the would-demote; "enforce" demotes ungrounded
  // score 2-3 findings to the review body (never hard-drops). Operator
  // flips via
  // `wrangler secret put OPENCLAW_INLINE_GROUNDING_VALIDATOR_MODE enforce`.
  OPENCLAW_INLINE_GROUNDING_VALIDATOR_MODE?: string

  // SIG-290 v1: absence-claim grounding gate mode. "off" (default) skips
  // the gate; "shadow" counts + telemeters the would-demote but keeps
  // every finding inline; "enforce" demotes an absence-claim ("lacks
  // tests", "no null check", "missing validation") to the review body
  // when the evidence that would confirm-or-refute the absence was
  // provably outside the specialist's window (never hard-drops). Operator
  // flips via
  // `wrangler secret put OPENCLAW_ABSENCE_CLAIM_VALIDATOR_MODE shadow`.
  OPENCLAW_ABSENCE_CLAIM_VALIDATOR_MODE?: string

  // SIG-293 v1: security-grounding gate mode. "off" (default) skips the
  // gate; "shadow" counts + telemeters the would-demote but keeps every
  // finding inline; "enforce" demotes a "secrets-exposure" (CWE-798)
  // finding to the review body when its cited line holds no credential
  // token and no scanner fact corroborates it (never hard-drops). The one
  // line-level-detectable security category — the deeper root of Pattern A
  // (#248). Operator flips via
  // `wrangler secret put OPENCLAW_SECURITY_GROUNDING_VALIDATOR_MODE shadow`.
  OPENCLAW_SECURITY_GROUNDING_VALIDATOR_MODE?: string

  // SIG-311 Layers A+B: security USAGE-vs-MENTION validator. off (default) |
  // shadow (count/telemeter the would-demote, keep inline) | enforce (demote a
  // sev>=4 injection/xss finding on a detector/validator/test/doc path whose
  // cited token is a mention, not a live sink — the PR #296 self-FP family).
  // Demote-not-drop, keep on any uncertainty.
  OPENCLAW_SECURITY_USAGE_VALIDATOR_MODE?: string

  // Cross-cutting over-fire Option B: window-blindness validator. off (default) |
  // shadow (count/telemeter the would-demote, keep inline) | enforce (demote a
  // sev>=4 logic positive-misread — "X can be undefined / returns NaN / is
  // unbounded" — when the guard on the SAME cited symbol is provably present in
  // the full file but outside the diff window the model saw). Demote-not-drop,
  // keep on any uncertainty. The deterministic backstop to PR #327's prompt fence.
  OPENCLAW_WINDOW_BLINDNESS_VALIDATOR_MODE?: string

  // SIG-121 (SIG-109 PR B): symbol-based retrieval for the logic
  // specialist. "on" fires a second, AST-symbol-derived retrieval pass
  // that AUGMENTS the logic role's shared snapshot; any other value
  // (including unset) keeps it off so the feature ships dark. Operator
  // flips via `wrangler secret put OPENCLAW_SYMBOL_RETRIEVAL on`.
  OPENCLAW_SYMBOL_RETRIEVAL?: string

  // SIG-407: symbol-aware retrieval for the @-mention Q&A path. Expands each
  // retrieval hit (a ~30-line slice) into its ENCLOSING symbol body + direct
  // callers from the SIG-138 graph, so the answer model reasons over the whole
  // symbol. Distinct from SIG-121's OPENCLAW_SYMBOL_RETRIEVAL above: that is a
  // REVIEW-time second query-term bias for the logic specialist; this is a
  // MENTION-time graph EXPANSION. Tri-state, default off:
  //   - "off"/unset → no expansion; DO never queried; output byte-identical.
  //   - "shadow"    → build the block + telemeter, inject NOTHING (byte-identical).
  //   - "on"        → inject the expanded symbol block.
  // Both the single-shot mention path AND the agentic retrieve_codebase tool
  // honor it (so a future OPENCLAW_AGENTIC_GITHUB_MODE=on can't bypass it).
  // Flip via `wrangler secret put OPENCLAW_MENTION_SYMBOL_EXPANSION shadow`.
  OPENCLAW_MENTION_SYMBOL_EXPANSION?: string

  // SIG-129: branch-aware retrieval. When "on", the PR-review ensemble
  // overlays the changed-file HEAD content onto the main-index retrieval
  // results (head wins on path collision) so a PR's new/changed code is
  // retrievable. Default off; flip via
  // `wrangler secret put OPENCLAW_BRANCH_AWARE_RETRIEVAL on`.
  OPENCLAW_BRANCH_AWARE_RETRIEVAL?: string

  // SIG-45: hybrid lexical (BM25 via D1 FTS5) + vector (Vectorize)
  // retrieval, merged via reciprocal-rank fusion. When "on" AND the
  // OPENCLAW_LEXICAL_INDEX D1 binding is present, the PR-review retrieval
  // path queries both backends in parallel and fuses the results; the
  // indexer also dual-writes every chunk to the lexical mirror. Any other
  // value (including unset) keeps it dark — pure-vector, no dual-write.
  // Flip via `wrangler secret put OPENCLAW_RETRIEVAL_HYBRID on`.
  OPENCLAW_RETRIEVAL_HYBRID?: string

  // SIG-44: multi-corpus retrieval. When "on", the PR-review ensemble also
  // queries the `pr:<owner>/<repo>` (merged-PR title/body/verdict) and
  // `issue:<owner>/<repo>` (Linear issue) Vectorize namespaces and injects
  // labeled snippet blocks (`--- past PR #234 (verdict: ...) ---`) so
  // specialists can cite "same regression as PR #234". Any other value
  // keeps it dark. The corpora are populated by the merged-PR / Linear-issue
  // refresh paths + the 90-day backfill (see src/lib/multi-corpus.ts).
  // Flip via `wrangler secret put OPENCLAW_MULTICORPUS_RETRIEVAL on`.
  OPENCLAW_MULTICORPUS_RETRIEVAL?: string

  // Cross-repo review context. When "on", PR-review retrieval is grounded not
  // only in the PR's own repo index but also in its SIBLING repos in the SAME
  // GitHub App installation (resolved owner-scoped from the indexed-repo
  // manifest set — hard tenant isolation, never cross-owner, never a repo the
  // app isn't installed on). Sibling chunks are down-weighted and hard-capped so
  // the PR repo stays weighted-highest. Any other value keeps it dark
  // (single-repo behavior, unchanged). Flip via
  // `wrangler secret put OPENCLAW_CROSS_REPO_CONTEXT on`.
  OPENCLAW_CROSS_REPO_CONTEXT?: string

  // SIG-144: review output surface. Controls WHERE findings are posted —
  // GitHub Checks annotations (inline in the Files tab + Checks UI, like
  // CodeRabbit/Copilot), PR review comments (the historical default), or both.
  //   - unset / "comments" → PR review comments only (default; no annotations)
  //   - "both"             → review comments AND Checks annotations
  //   - "annotations"      → Checks annotations only; the formal review still
  //                          submits the verdict (APPROVE/REQUEST_CHANGES) +
  //                          summary body, but inline review comments are
  //                          suppressed and findings live in the annotations.
  // Annotation messages are rendered as PLAIN TEXT (SIG-216: GitHub does not
  // render markdown in the annotation `message` field). Flip via
  // `wrangler secret put OPENCLAW_REVIEW_OUTPUT_SURFACE both`.
  OPENCLAW_REVIEW_OUTPUT_SURFACE?: string

  // Dynamic review evidence cards. "shadow" computes/logs card coverage only;
  // "post" injects the precomputed changed-symbol/context cards into
  // specialist + synth prompts. Any other value keeps it off.
  OPENCLAW_DYNAMIC_REVIEW_EVIDENCE?: string

  // SIG-452: adversarial-framing hardening. off (default) | shadow | enforce.
  // The "removed guarding test for a CHANGED symbol" signal (benchmark #29: a
  // plausible behavioral change that removes its regression test in the SAME PR,
  // which the model was waving through as "intentional contract change").
  //   - "off"     → signal not computed, no prompt block, no extra IO →
  //                 byte-identical to today.
  //   - "shadow"  → compute the signal + log counts by correlation strength ONLY.
  //                 Output stays byte-identical (no prompt block, no would-flag/
  //                 would-keep — that needs an extra model call, out of v1 scope).
  //   - "enforce" → also fetch GitHub file metadata (status/previous_filename for
  //                 rename exclusion), build the SYMBOL-grade signal, and inject
  //                 the enforce-gated conditional blocks into BOTH the logic
  //                 specialist's and the synth's user messages (the inverted-
  //                 inference rule). Parsed by parseAdversarialFramingMode.
  OPENCLAW_ADVERSARIAL_FRAMING_MODE?: string

  // SIG-112: dev/dogfood override for visible finding evidence blocks.
  // "on" renders the per-finding collapsible provenance block regardless of
  // sigilix.json; any other value leaves customer visibility to
  // sigilix.json::evidence.visible.
  OPENCLAW_SHOW_EVIDENCE?: string

  // SIG-228 Phase 3c — synth-bypass single-specialist hot path. When "on",
  // skip the synthesizer LLM call entirely if the dispatcher returned
  // exactly 1 specialist AND none of that specialist's findings have
  // `score >= 4` (major/critical). The specialist's verdict becomes the
  // submission directly. Saves ~15-25s on the hot path; safe by
  // construction (no cross-specialist consensus to compute, no
  // major-severity findings that benefit from synth-level rewriting).
  // Any other value (including unset) keeps the legacy always-synth
  // behavior.
  OPENCLAW_SYNTH_BYPASS_ENABLED?: string

  // SIG-235 — min-specialists early exit. Three-state rollout:
  //   "off"     — default; fan-out waits for ALL dispatched specialists
  //               to settle (legacy `Promise.allSettled` semantics).
  //   "shadow"  — fan-out STILL waits for all, but emits
  //               `ensemble-min-specialists-early-exit-would-fire`
  //               telemetry the moment `N-1` of `N` specialists return
  //               successfully + `savedMsIfEnforced` so we can size the
  //               win before enforcing.
  //   "on"      — fires synth as soon as `N-1` of `N` specialists return
  //               successfully; aborts the laggard role's outstanding
  //               attempts via per-role AbortController. Synth runs on
  //               the partial input with the existing `[DEGRADED COVERAGE]`
  //               block. Late verdicts from the cancelled role are logged
  //               (`ensemble-late-verdict-discarded`) but discarded.
  OPENCLAW_MIN_SPECIALISTS_EARLY_EXIT?: string

  // SIG-236 — surgical prompt-budget for the logic specialist. Three-
  // state rollout:
  //   "off"     — default; no telemetry, no truncation.
  //   "shadow"  — measure the constructed logic prompt's per-section
  //               size + emit `logic-prompt-budget` telemetry; the
  //               prompt passes through untouched. Used to size the
  //               enforce-mode cuts before flipping.
  //   "enforce" — NOT YET IMPLEMENTED. Behaves like "shadow" but
  //               records `mode: "enforce-pending"` in the event so
  //               dashboards can flag a premature flip. The actual
  //               truncation lands in a follow-up PR informed by
  //               shadow data.
  OPENCLAW_LOGIC_PROMPT_BUDGET?: string
  // ARC-234: customer-ready indexing pipeline feature flag. Default
  // "off" preserves the legacy `app-level event ignored` drop so the
  // producer ships dark. Operator flips to "on" via
  // `wrangler secret put OPENCLAW_INDEXER_ENABLED on` AFTER both the
  // producer (ARC-234) AND consumer (ARC-235) deploy. Any other value
  // (including unset) keeps indexing disabled.
  OPENCLAW_INDEXER_ENABLED?: string
  // SIG-413: PR-head-branch full-index enqueue. DEFAULT OFF — only "on" enables
  // (anything else, including unset, keeps it off). The review path retrieves from
  // the MAIN namespace + the SIG-129 in-memory branch overlay, so the persistent
  // per-branch index is never read by review; building one per PR was ~380x
  // redundant embedding churn. "on" restores the legacy enqueue during the soak.
  OPENCLAW_PR_BRANCH_INDEX?: string

  // SIG-35: comma-separated long-lived non-default branches to persistently
  // index in addition to the repo default branch. Defaults in code cover
  // dev/develop/development/staging/stage; this var lets customers add
  // names like "qa,release-candidate" without a deploy.
  OPENCLAW_INDEX_BRANCHES?: string

  // SIG-131: AST-aware chunking. When "on", JS/TS files chunk on AST
  // boundaries (effective CHUNKER_VERSION 3) and repos re-index under the new
  // scheme; default off (line-window, version 2). Flip via
  // `wrangler secret put OPENCLAW_AST_CHUNKING on`.
  OPENCLAW_AST_CHUNKING?: string

  // Repo-role classification. When "on", the index-repo job computes the repo's
  // role (frontend / backend / infra / library / mobile / fullstack / unknown)
  // from cheap signals (tree paths + package.json) and stamps it on the repo's
  // index manifest. DEFAULT OFF — only "on" enables (anything else, including
  // unset, keeps it off, so no extra package.json fetch happens). Purely
  // ADDITIVE metadata: nothing reads `role` yet, so a flip is zero-behavior;
  // any classification failure yields `unknown` and never fails the index job.
  OPENCLAW_REPO_ROLE_CLASSIFY?: string

  // ARC-283 Phase B1b — shadow-mode model bake-off. CSV of role names
  // whose CANDIDATE lineup (per `SHADOW_BAKEOFF_LINEUP` in
  // `lib/shadow-bakeoff-config.ts`) should fire in parallel with prod
  // on every PR review. Unset/empty = shadow off everywhere (the prod
  // path takes ZERO added code branches). Shadow verdicts are NEVER
  // posted; comparison telemetry emits via `shadow-verdict-comparison`
  // events. Valid roles: logic, security, performance, tests, synth.
  // Recommended rollout order: "synth" first, then "security,tests",
  // then "performance", then "logic". See docs/ops/shadow-bakeoff.md.
  SHADOW_BAKEOFF_ROLES?: string

  // SIG-455: per-tenant fairness gate feature flags.
  //   SIGILIX_FAIRNESS_MODE             "off" | "shadow" | "enforce" (default "shadow").
  //                                     "off"     — gate fully bypassed, no telemetry.
  //                                     "shadow"  — gate runs + telemeters, reviews pass.
  //                                     "enforce" — deferred reviews are re-enqueued.
  //   SIGILIX_TENANT_CONCURRENCY_CAP    integer string; per-tenant concurrent-review cap.
  //                                     Default 2. Operates within the global queue cap.
  SIGILIX_FAIRNESS_MODE?: string
  SIGILIX_TENANT_CONCURRENCY_CAP?: string

  // SIG-455 PR B: provider backpressure cooldown mode.
  //   "off"     (default / unset / unknown) — cooldown logic fully bypassed.
  //   "shadow"  — cooldown state tracked + telemetered, no request blocking.
  //   "enforce" — requests are held/rejected when a provider is in cooldown.
  SIGILIX_PROVIDER_COOLDOWN_MODE?: string

  // SIG-543: per-tenant quota enforcement mode.
  //   "shadow"  (default / unset / unknown) — quota state tracked + telemetered, no blocking.
  //   "off"     — quota logic fully bypassed.
  //   "enforce" — reviews are rejected when a tenant exceeds their daily budget.
  SIGILIX_TENANT_QUOTA_MODE?: string

  // SIG-38: per-tenant rate-limit enforcement mode (rolling-window request cap).
  //   "shadow"  (default / unset / unknown) — rate-limit state tracked + telemetered, no blocking.
  //   "off"     — rate-limit logic fully bypassed.
  //   "enforce" — reviews are rejected when a tenant exceeds their rolling-window cap.
  SIGILIX_RATE_LIMIT_MODE?: string

  // sig-cost-based-metering: per-tier, per-window USD cost budgets that override the
  // TIER_COST_BUDGET_USD table in domain/rate-limit.ts (the founder's margin decision).
  // Each is a number of USD; a NEGATIVE value = "no cap" (unbounded); blank/non-numeric
  // is ignored (falls back to the table). SESSION is the enforced 5h rolling-window
  // budget (check-rate-limit gates on it); WEEKLY is surfaced by /v1/usage. Enterprise
  // has no override — it is always unbounded. Unset → the table defaults.
  SIGILIX_COST_BUDGET_FREE_SESSION?: string
  SIGILIX_COST_BUDGET_FREE_WEEKLY?: string
  SIGILIX_COST_BUDGET_PRO_SESSION?: string
  SIGILIX_COST_BUDGET_PRO_WEEKLY?: string
  SIGILIX_COST_BUDGET_TEAMS_SESSION?: string
  SIGILIX_COST_BUDGET_TEAMS_WEEKLY?: string
  SIGILIX_COST_BUDGET_MAX_SESSION?: string
  SIGILIX_COST_BUDGET_MAX_WEEKLY?: string
  SIGILIX_COST_BUDGET_ULTRA_SESSION?: string
  SIGILIX_COST_BUDGET_ULTRA_WEEKLY?: string

  // sig-free-tier-entitlements: master rollout switch for the paid-only feature
  // gate (CI-failure triage, the Slack assistant, Linear triage/agent are
  // Pro/Teams/Max/Ultra/Enterprise only). "off" (default/unset/unknown) — NO gating, byte-identical
  // to pre-entitlements behavior. "shadow" — resolve the plan and LOG what would be
  // gated, but allow it (validate on live traffic before enforcing). "enforce" —
  // actually gate an un-entitled installation. Resolved by resolveEntitlementsMode
  // (@/features/entitlements); ships dark.
  OPENCLAW_ENTITLEMENTS_MODE?: string

  // SIG-343 PR C: platform DB — tenant/repo/usage_ledger + (SIG-38) triage_usage_ledger.
  // Optional so a deploy that hasn't provisioned/migrated D1 stays metering-off (dark).
  SIGILIX_PLATFORM_DB?: D1Database

  // SIG-303 full usage metering (two independent pools: ORG + SEAT). Own flag +
  // tunable per-(pool × window) caps, independent of the SIG-38 PR-review gate.
  //   SIGILIX_USAGE_METER_MODE      "shadow" (default/unknown) | "off" | "enforce".
  //                                 shadow = record + telemeter, never block; enforce =
  //                                 block the NEXT run/request over its pool cap.
  //   SIGILIX_USAGE_CAP_SEAT_SESSION / _WEEKLY   per-dev SEAT pool caps (coding_agent +
  //                                 chatbot). Integer count; negative = no cap. Unset →
  //                                 DEFAULT_POOL_CAPS.seat (40 / 5h · 200 / 7d).
  //   SIGILIX_USAGE_CAP_ORG_SESSION / _WEEKLY    shared ORG pool caps (pr_reviews +
  //                                 linear_triage + slack). Integer count; negative = no
  //                                 cap. Unset → DEFAULT_POOL_CAPS.org (20 / 5h · 100 / 7d).
  // All caps are placeholders the founder / SIG-41 (Stripe) tunes; weekly is the headline.
  SIGILIX_USAGE_METER_MODE?: string
  SIGILIX_USAGE_CAP_SEAT_SESSION?: string
  SIGILIX_USAGE_CAP_SEAT_WEEKLY?: string
  SIGILIX_USAGE_CAP_ORG_SESSION?: string
  SIGILIX_USAGE_CAP_ORG_WEEKLY?: string

  // sig-training-data-consent: the MASTER kill switch for the consent-gated
  // training corpus. Layered ON TOP of per-org consent — even a consented org's
  // data is NEVER written unless this is on. FAIL-CLOSED: only the exact string
  // "on" enables retention; unset (the launch default) / "" / "true" / "shadow"
  // / any other value keeps it off, so no capture path can ever reach the store.
  // Do NOT flip to "on" until the legal prerequisites in
  // src/features/training-consent/README.md (consent language in the ToS, a
  // GDPR/CCPA deletion path, data-processing terms) are signed off. Parsed by
  // resolveTrainingRetentionMode (@/features/training-consent). Operator flips
  // via `wrangler secret put SIGILIX_TRAINING_RETENTION_MODE on`.
  SIGILIX_TRAINING_RETENTION_MODE?: string

  // SIG-41 (Stripe paid tier): the Stripe integration. ALL optional — unset
  // SIGILIX_STRIPE_WEBHOOK_SECRET keeps POST /stripe/webhook returning 503 (inert), so
  // a deploy without Stripe configured is unaffected. Resolved SIGILIX_-first via the
  // normalizeEnv shim like every other SIGILIX_ var.
  //   SIGILIX_STRIPE_SECRET_KEY     — the Stripe API secret (`sk_live_…` / `sk_test_…`).
  //                                   Reserved for outbound Stripe calls (subscription
  //                                   fetch, portal sessions); the webhook itself needs
  //                                   only the signing secret below. Set via
  //                                   `wrangler secret put SIGILIX_STRIPE_SECRET_KEY`.
  //   SIGILIX_STRIPE_WEBHOOK_SECRET — the `whsec_…` signing secret Stripe shows after
  //                                   you save the webhook destination. HMAC-verifies
  //                                   every delivery; unset → the route 503s. Set via
  //                                   `wrangler secret put SIGILIX_STRIPE_WEBHOOK_SECRET`.
  //   SIGILIX_STRIPE_PRICE_PRO / _TEAMS / _MAX / _ULTRA — the monthly Stripe price ids (`price_…`).
  //   SIGILIX_STRIPE_PRICE_PRO_ANNUAL / _TEAMS_ANNUAL /
  //   _MAX_ANNUAL / _ULTRA_ANNUAL — the optional annual Stripe price ids. Together
  //                                   these map a subscription to the Sigilix
  //                                   pro/teams/max/ultra tier. A price with no id match
  //                                   falls back to a `lookup_key`/`nickname` containing
  //                                   pro|teams|max|ultra.
  SIGILIX_STRIPE_SECRET_KEY?: string
  SIGILIX_STRIPE_WEBHOOK_SECRET?: string
  SIGILIX_STRIPE_PRICE_PRO?: string
  SIGILIX_STRIPE_PRICE_TEAMS?: string
  SIGILIX_STRIPE_PRICE_MAX?: string
  SIGILIX_STRIPE_PRICE_ULTRA?: string
  SIGILIX_STRIPE_PRICE_PRO_ANNUAL?: string
  SIGILIX_STRIPE_PRICE_TEAMS_ANNUAL?: string
  SIGILIX_STRIPE_PRICE_MAX_ANNUAL?: string
  SIGILIX_STRIPE_PRICE_ULTRA_ANNUAL?: string

  // sig-github-marketplace-billing: GitHub Marketplace subscriptions arrive at the SAME
  // POST /github/webhook endpoint (X-GitHub-Event: marketplace_purchase), verified by
  // GITHUB_WEBHOOK_SECRET like every other GitHub event — no separate secret.
  //   GITHUB_MARKETPLACE_PLAN_MAP — JSON {"<plan_id>":"pro","<plan_id>":"teams",...} that
  //                                 pins each Marketplace plan id to a Sigilix tier
  //                                 (free/pro/teams/max/ultra — NEVER enterprise). Plan ids
  //                                 aren't known until the founder creates the plans, so
  //                                 this is set once, after, WITHOUT a code change. Absent /
  //                                 a plan not in the map → the case-insensitive plan-NAME
  //                                 heuristic, then a fail-closed `free`. Set via [vars]:
  //                                 `wrangler ... ` or the dashboard.
  GITHUB_MARKETPLACE_PLAN_MAP?: string

  // Portal Organization page (GET /v1/org/overview) — plan + per-seat billing
  // display placeholders. Both optional: absent OPENCLAW_PLAN defaults to "free";
  // absent/invalid OPENCLAW_PER_SEAT_PRICE surfaces perSeatMonthly=null ("billing
  // at launch"). Values are display-only until real Stripe billing lands.
  //   OPENCLAW_PLAN            "free" (default) | "pro" | "max" | "ultra" | "team" | "enterprise".
  //   OPENCLAW_PER_SEAT_PRICE  monthly per-seat price, parsed as a number (e.g. "20").
  OPENCLAW_PLAN?: string
  OPENCLAW_PER_SEAT_PRICE?: string

  OPENCLAW_ORG_MEMBERSHIP_MODE?: string
  // SIG-545 A: GitHub-PR "@sigilix make a linear triage" command.
  //   OPENCLAW_GITHUB_LINEAR_TRIAGE_MODE  "off" (default/unknown) | "shadow" | "on".
  //   OPENCLAW_GITHUB_REPO_LINEAR_TEAM_MAP  JSON {"owner/repo":"<linearTeamId>","owner":"<linearTeamId>"}
  //                                         (the Linear team UUID; exact owner/repo then owner fallback).
  OPENCLAW_GITHUB_LINEAR_TRIAGE_MODE?: string
  OPENCLAW_GITHUB_REPO_LINEAR_TEAM_MAP?: string

  // SIG-196: Sigilix Slack agent. Secrets via `wrangler secret`; mode via [vars].
  //   SIGILIX_SLACK_MODE      "off" (default/unknown) | "shadow" | "on".
  //   SIGILIX_SLACK_SCOPE_MAP  JSON {"<teamId>:<channelId>":{"repos":["owner/repo"],"linearTeam":"<LINEAR_TEAM_ID>"}}
  //                            repos must be EXACT owner/repo entries present in OPENCLAW_GITHUB_INSTALLATION_MAP;
  //                            FALLBACK ONLY: D1 bindings (migration 0019) are checked FIRST — slack-scope.ts.
  SLACK_SIGNING_SECRET?: string
  SLACK_CLIENT_ID?: string
  SLACK_CLIENT_SECRET?: string
  SLACK_BOT_TOKEN?: string
  SIGILIX_SLACK_MODE?: string
  SIGILIX_SLACK_SCOPE_MAP?: string

  // sig-mcp-slack-static-oauth: Sigilix's PRE-REGISTERED confidential OAuth
  // client for Slack's hosted MCP server (https://mcp.slack.com/mcp), which
  // requires a static client_id + client_secret (no DCR). SEPARATE from the
  // SIG-196 SLACK_CLIENT_ID/SLACK_CLIENT_SECRET above (that is the Slack
  // webhook/triage app). The id is a non-secret [vars] value; the secret is
  // provisioned via `wrangler secret put`.
  SIGILIX_SLACK_CLIENT_ID?: string
  SIGILIX_SLACK_CLIENT_SECRET?: string

  // SIG-545 B1: hosted agent-runner (Cloudflare Container, dark by default).
  //   AGENT_RUNNER                   — DO namespace; one instance per runId.
  //                                    Backed by the AgentRunnerContainer class
  //                                    (src/do/agent-runner-container.ts).
  //   OPENCLAW_AGENT_RUNNER_MODE     — "off" (default/unset) | "on". Only the
  //                                    exact string "on" enables dispatch; any
  //                                    other value keeps the container configured
  //                                    but never invoked (fail-closed).
  //   OPENCLAW_PORTAL_AGENT_RUNNER_MODE — second, portal-only gate. Both this
  //                                    and the global runner mode must be "on"
  //                                    before a session-authenticated portal run
  //                                    can dispatch. Unset in production for the
  //                                    initial preview-only rollout.
  //   OPENCLAW_AGENT_RUNNER_ENGINE   — "minimal" (default/unset) | "full" (SIG-545
  //                                    B2). Selects the in-container engine: the
  //                                    bounded 5-tool loop vs the full CLI agent.
  //                                    Fail-closed to "minimal".
  //   OPENCLAW_AGENT_GROUNDING_ENDPOINT — (SIG-545 B2) the Worker's OWN public base
  //                                    URL (e.g. https://sigilix.<sub>.workers.dev)
  //                                    that the container's sigilix-grounding plugin
  //                                    calls for /v1/context + /v1/memory. NOT
  //                                    OPENCLAW_BASE_URL (that's the OAuth/marketing
  //                                    origin). Unset → grounding omitted (full agent
  //                                    runs blind). Bearer: OPENCLAW_SIGILIX_API_KEY.
  //   OPENCLAW_LINEAR_AGENT_RUN_MODE — "off" (default/unset) | "on" (SIG-545 B3).
  //                                    Only the exact string "on" arms the
  //                                    Linear-assignment trigger that dispatches the
  //                                    agent-runner on a SAFE minimal engine when an
  //                                    issue is assigned to the Sigilix agent user.
  //                                    Fail-closed to "off".
  //   OPENCLAW_LINEAR_AGENT_USER_ID  — (SIG-545 B3) the Linear user id of the Sigilix agent.
  //                                    An Issue.update assigning THIS user is the trigger; unset → inert.
  AGENT_RUNNER: DurableObjectNamespace
  AGENT_MCP_CAPABILITY: DurableObjectNamespace
  OPENCLAW_AGENT_RUNNER_MODE?: string
  OPENCLAW_PORTAL_AGENT_RUNNER_MODE?: string
  OPENCLAW_AGENT_RUNNER_ENGINE?: string
  OPENCLAW_PORTAL_FULL_ENGINE_MODE?: string
  OPENCLAW_AGENT_GROUNDING_ENDPOINT?: string
  // SIGILIX_AGENT_EVENTS_ENDPOINT — Worker base for per-run-secret live file-edit events; unset → no streaming.
  SIGILIX_AGENT_EVENTS_ENDPOINT?: string
  OPENCLAW_AGENT_EVENTS_ENDPOINT?: string
  SIGILIX_AGENT_MCP_ENDPOINT?: string
  OPENCLAW_AGENT_MCP_ENDPOINT?: string
  OPENCLAW_LINEAR_AGENT_RUN_MODE?: string
  OPENCLAW_LINEAR_AGENT_USER_ID?: string
  // Install hardening: when SET, the actor=app OAuth callback only accepts installs
  // from this Linear organization id; UNSET → install allowed + a warning is logged.
  OPENCLAW_LINEAR_ALLOWED_ORG_ID?: string
  /** SIG-242 dogfood-only cutover: the GitHub installation allowed to migrate/read the pre-tenant singleton. Both this and the
   * allowed Linear org id must match; unset disables the legacy seam. */
  OPENCLAW_LINEAR_LEGACY_INSTALLATION_ID?: string

  // SIG-144 (Linear unification cutover, slice 4): flag-gates `buildLinearAuth`'s
  // credential choice (src/lib/linear.ts).
  //   "off" (default/unset/unknown) — buildLinearAuth is byte-identical to its
  //     pre-slice-4 behavior: client_credentials app-actor token, falling back to
  //     the human LINEAR_API_KEY when OAuth isn't configured.
  //   "on" — buildLinearAuth returns the AGENT token via the LinearTokenBroker DO
  //     (getValidAgentTokenViaBroker, readOnly:false — the active triage/mutation
  //     path, not the 10s-ACK path, so a near-expiry token may be refreshed) and
  //     the LinearClient it backs carries the onUnauthorized broker-refresh-retry
  //     hook. When on and the broker returns no token (not installed, or a hard
  //     refresh failure), buildLinearAuth THROWS rather than falling back to
  //     LINEAR_API_KEY — post-cutover, silently mutating Linear under a human
  //     identity would hide a broken agent install.
  // Fail-closed to "off" (see resolveLinearUnifiedMode in linear.ts).
  OPENCLAW_LINEAR_UNIFIED?: string
}

// sig-worker-debrand-openclaw: the NEW canonical `SIGILIX_<X>` name for every legacy
// `OPENCLAW_<X>` binding / var / secret above. Derived from `Env` via key remapping so
// the ~180 pairs stay in sync automatically — no hand-maintained duplicate list. Every
// alias is OPTIONAL: it is only present once the founder sets the SIGILIX_ secret / var
// (or a SIGILIX_ binding is added to wrangler.toml). The value type mirrors the legacy
// key's (e.g. SIGILIX_CODE_INDEX?: VectorizeIndex, SIGILIX_STATE?: KVNamespace).
export type SigilixAliasEnv = {
  [K in keyof Env as K extends `OPENCLAW_${infer Rest}` ? `SIGILIX_${Rest}` : never]?: Env[K]
}

// The env shape AFTER `normalizeEnv`: the legacy contract PLUS every SIGILIX_ alias.
// Both names resolve to the same SIGILIX_-preferred value at runtime.
export type NormalizedEnv = Env & SigilixAliasEnv
