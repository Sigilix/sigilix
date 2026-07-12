// Bedrock-ensemble migration — the AWS + Bedrock slice of the Worker env,
// split out of `env.ts` as a composed per-feature sub-interface (`Env extends
// AwsBedrockEnv`) because `env.ts` sits AT its 1,500-line hard ceiling and its
// allowlist note names exactly this split as the real fix. Pure type leaf
// (same as env.ts): no imports, no runtime.
//
// Two INDEPENDENT AWS surfaces live here — do not conflate them:
//   1. `OPENCLAW_AWS_*` — the boreas-gateway failover leg's credentials
//      (#158 scaffold, disabled at launch). Relocated VERBATIM from env.ts.
//   2. `AWS_*` + `SIGILIX_ENSEMBLE_*` — the PR-review ensemble's Bedrock
//      migration (this PR). Separate credentials on purpose: flipping the
//      review ensemble onto Bedrock must not silently arm the gateway leg
//      (and vice versa).
export interface AwsBedrockEnv {
  // #158 failover chain, leg 3 (AWS Bedrock -- SCAFFOLD, disabled at launch).
  // Shared AWS credentials for the SigV4-signed Bedrock Runtime Converse call.
  // ALL THREE (region + access key id + secret) must be set for the Bedrock leg
  // to be attempted for ANY model; any one missing -> the leg is skipped
  // entirely (not a failure -- this is the founder-locked launch state until
  // real AWS creds exist). Set via `wrangler secret put` for the two secret
  // values; the region may be a plain [vars] entry.
  OPENCLAW_AWS_REGION?: string
  OPENCLAW_AWS_ACCESS_KEY_ID?: string
  OPENCLAW_AWS_SECRET_ACCESS_KEY?: string
  // Per-model Bedrock model id override -- also gates the leg per-model: even
  // with AWS creds configured, a route with its model id unset skips Bedrock
  // (no guessed model id). Same three-var pattern as the Turbo fallback above.
  OPENCLAW_BOREAS_FALLBACK_BEDROCK_MODEL?: string
  OPENCLAW_PYROEIS_FALLBACK_BEDROCK_MODEL?: string
  OPENCLAW_ASTRAEUS_FALLBACK_BEDROCK_MODEL?: string

  // ── Bedrock-ensemble migration (PR-review ensemble on AWS credits) ──
  // AWS credentials for the ensemble's Bedrock Converse calls. SECRETS — set
  // via `wrangler secret put AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`
  // (never [vars], never committed); AWS_REGION may be a [vars] entry
  // ("us-east-1"). ALL THREE must be set for the Bedrock lineup to activate;
  // any one missing → the SIGILIX_ENSEMBLE_PROVIDER flag degrades to the
  // OpenRouter default (never a failed role). Absent creds cannot affect the
  // default OpenRouter path at all.
  AWS_ACCESS_KEY_ID?: string
  AWS_SECRET_ACCESS_KEY?: string
  AWS_REGION?: string
  // The ensemble provider flag: "bedrock" migrates the four screened roles
  // (security, tests, performance, synth) onto the Bedrock lineup
  // (model-provider-bedrock.ts); "openrouter" / unset / ANY unknown value =
  // the shipped OpenRouter lineup, byte-identical. The GLOBAL flag never
  // moves LOGIC (K≥12 bake-off pending — SIG-450); logic flips only via the
  // explicit per-role flag below.
  SIGILIX_ENSEMBLE_PROVIDER?: string
  // Per-role provider overrides — a recognized value ("bedrock"|"openrouter")
  // beats the global flag for that role; unknown/unset falls through to it.
  SIGILIX_ENSEMBLE_PROVIDER_LOGIC?: string
  SIGILIX_ENSEMBLE_PROVIDER_SECURITY?: string
  SIGILIX_ENSEMBLE_PROVIDER_PERFORMANCE?: string
  SIGILIX_ENSEMBLE_PROVIDER_TESTS?: string
  SIGILIX_ENSEMBLE_PROVIDER_SYNTH?: string
  // Per-role Bedrock model-id overrides — replace the role's default Bedrock
  // PRIMARY (the OpenRouter fallback leg is untouched). The logic override is
  // the future bake-off's lever (e.g. "mistral.mistral-large-3-675b-instruct"
  // vs the default "us.anthropic.claude-sonnet-5" candidate).
  SIGILIX_ENSEMBLE_BEDROCK_MODEL_LOGIC?: string
  SIGILIX_ENSEMBLE_BEDROCK_MODEL_SECURITY?: string
  SIGILIX_ENSEMBLE_BEDROCK_MODEL_PERFORMANCE?: string
  SIGILIX_ENSEMBLE_BEDROCK_MODEL_TESTS?: string
  SIGILIX_ENSEMBLE_BEDROCK_MODEL_SYNTH?: string
}
