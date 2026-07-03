# training-consent

Consent-gated, **physically separated** storage for the data Sigilix is allowed to
train models on. The default is **do NOT retain**. Separation is **fail-closed** at
every layer.

## Why this exists

Some users/orgs consent to let Sigilix train on their data; most do not. Their data
must be **hard-separated**, and the consented data retained long-term. Because this
is legally load-bearing, the design fails **closed**: absent an explicit, positive
signal, nothing is retained.

## The separation guarantee (three independent locks)

1. **Master flag** — `SIGILIX_TRAINING_RETENTION_MODE` (default `off`). Only the exact
   string `"on"` enables retention. Checked first in the gate, so with the launch
   default nothing is even read.
2. **Per-org consent** — `data_learning_consent` (D1, migration `0008`). An explicit
   `granted`/`denied` row wins; absent a row, a **fail-closed plan default** applies
   (personal paid → granted/opt-out; team + enterprise + free + **unknown** →
   denied/opt-in). A paid team we can't positively identify as personal → **denied**.
3. **Separate store** — `SIGILIX_TRAINING_DATA` (a dedicated **R2 bucket**, a
   *different binding* from every operational store: KV `OPENCLAW_STATE`, D1
   `SIGILIX_PLATFORM_DB`, the Vectorize indexes). The bucket is **not provisioned at
   launch**, so the binding is absent and every write no-ops. No operational code path
   references it, so non-consented data has **no route in**.

### Why R2 (not a second D1)

A training corpus is an append-only pile of large text blobs read in bulk offline —
R2's shape, not D1's (row/db size limits, transactional SQL we don't need). A dedicated
bucket also gets its own lifecycle, retention policy, and access grants: the separation
is structural, not a `WHERE` clause someone can forget.

## The gate

`mayRetainForTraining(env, installationId)` is the single source of truth. It returns
true only when **flag on AND consent granted**. `retainForTraining(env, id, record)` is
the **only** sanctioned writer: it runs the gate, **redacts** (`redactTrainingRecord`),
then stores — in that order. Redaction-before-store is structural, not left to callers.

## Per-org isolation & right-to-forget

Every object is keyed `installation/<id>/…`. Reads/writes/purges are prefix-scoped, so
one org's corpus can't be listed, written, or deleted under another's. On consent
revocation (or a deletion request), `purgeTrainingData(env, installationId)` lists +
deletes that prefix only.

## API

- `GET  /v1/org/:installationId/data-consent` — effective consent + provenance (admin).
- `POST /v1/org/:installationId/data-consent` — set consent (admin). `denied` purges.

Both are session-only and gated by `isAdminOfInstallation` (per-installation, which
also enforces tenant isolation).

## Wiring seam (flagged off)

One representative call site is wired today — in the learnings org-mirror capture
(`src/features/learnings/adapters/org-mirror.ts`) — and is **inert** (the flag is off).
The other capture surfaces the audit identified (review findings, portal/agent chat, the
codebase index) each have a future seam and are **not** wired in this scaffold.

## LEGAL PREREQUISITES — before `SIGILIX_TRAINING_RETENTION_MODE` is ever `on`

This scaffold must NOT be enabled until legal signs off on ALL of:

1. **ToS / consent language** — explicit, specific, opt-in/opt-out terms describing that
   consented data is used to train Sigilix models, retained long-term, and how to revoke.
   The plan-based opt-out default (individual/pro) must be reflected in the ToS the user
   accepted; team/enterprise opt-in must be an affirmative admin action.
2. **GDPR / CCPA deletion path** — a documented, tested data-subject deletion + org-level
   right-to-forget (`purgeTrainingData` is the mechanism) with an SLA, plus deletion
   propagation to any downstream trained artifacts / derived datasets.
3. **Data-processing terms (DPA)** — sub-processor disclosure, data-residency for the R2
   bucket, retention schedule, and a lawful basis for processing recorded per org.
4. **Redaction sign-off** — the `redact` seam upgraded to a full secret/PII DLP pass and
   reviewed; confirm no secrets/PII enter the corpus.
5. **Provisioning** — create the R2 bucket, uncomment the `wrangler.toml` binding, deploy,
   and only then flip the flag. Consider a separate bucket per data-residency region.
