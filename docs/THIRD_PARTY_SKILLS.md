# Governed third-party skills

SIG-561 seeds a deliberately small, guidance-only catalog. The Worker does not
download these repositories at runtime and never executes package code, shell
commands, or package-supplied tools. Each runtime instruction is a bounded,
Sigilix-authored excerpt reviewed in the same pull request as its manifest.

## Source and license ledger

| Skill | Publisher | Pinned commit | Upstream `SKILL.md` SHA-256 | License |
| --- | --- | --- | --- | --- |
| `supabase-postgres-best-practices` | Supabase | `1ad9aaeb49caafd9e95c0a91116f71890eebbc53` | `ccd6e4596bd51cf344fe76c464867c541ccc16b6d90ae7a9db449fb17588613b` | [MIT](https://github.com/supabase/agent-skills/blob/1ad9aaeb49caafd9e95c0a91116f71890eebbc53/LICENSE) |
| `cloudflare-workers-best-practices` | Cloudflare | `27ce0c0e159225caa7ed30ebefd4107aa6c52497` | `099432ff265ff6080327ef0b392c118b835d2a5bda98a7de07e1afd115ed6458` | [Apache-2.0](https://github.com/cloudflare/skills/blob/27ce0c0e159225caa7ed30ebefd4107aa6c52497/LICENSE) |
| `cloudflare-durable-objects` | Cloudflare | `27ce0c0e159225caa7ed30ebefd4107aa6c52497` | `cd6797cb18f3ae8f721dfd2e5cb27b73a0aa8636683f1a38163dab2fd51a8dfb` | [Apache-2.0](https://github.com/cloudflare/skills/blob/27ce0c0e159225caa7ed30ebefd4107aa6c52497/LICENSE) |
| `openai-security-best-practices` | OpenAI | `49f948faa9258a0c61caceaf225e179651397431` | `7b3dae1ffc5434d890f3c65c8f552af52d0307fab3b35dec13013c9ca3844c4f` | [Apache-2.0](https://github.com/openai/skills/blob/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/security-best-practices/LICENSE.txt) |
| `openai-security-threat-model` | OpenAI | `49f948faa9258a0c61caceaf225e179651397431` | `1283c0dd62a8104d9edda4583569b5d8510b4ddaa45120687c999250fd96bad2` | [Apache-2.0](https://github.com/openai/skills/blob/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/security-threat-model/LICENSE.txt) |

The Apache license is distributed in `LICENSE-APACHE`. The Supabase copyright
and MIT terms are distributed in `LICENSE-MIT-SUPABASE`.

### Reproduce the source hashes

Checkout each repository at the exact commit above and hash the named file:

```sh
git clone https://github.com/supabase/agent-skills.git
git -C agent-skills checkout 1ad9aaeb49caafd9e95c0a91116f71890eebbc53
sha256sum agent-skills/skills/supabase-postgres-best-practices/SKILL.md

git clone https://github.com/cloudflare/skills.git cloudflare-skills
git -C cloudflare-skills checkout 27ce0c0e159225caa7ed30ebefd4107aa6c52497
sha256sum cloudflare-skills/skills/workers-best-practices/SKILL.md
sha256sum cloudflare-skills/skills/durable-objects/SKILL.md

git clone https://github.com/openai/skills.git openai-skills
git -C openai-skills checkout 49f948faa9258a0c61caceaf225e179651397431
sha256sum openai-skills/skills/.curated/security-best-practices/SKILL.md
sha256sum openai-skills/skills/.curated/security-threat-model/SKILL.md
```

The runtime excerpts are not represented as upstream quotations. Their exact
NFC-normalized UTF-8 bytes and SHA-256 values live in `domain/catalog.ts`; the
catalog test recomputes every hash so an instruction edit cannot retain stale
provenance. Review status is `approved-guidance-only`, reviewed by
`sigilix-engineering` on 2026-07-11.

## Enforcement boundary

- Catalog entries are compiled server-side. An organization administrator can
  only enable or revoke known IDs; no endpoint accepts instruction text.
- Every surface defaults off. This seed is eligible only for portal chat and
  deep research; CLI, agent, memory, and PR review receive no skill text.
- Skill-influenced model calls receive no tool descriptors, and their output is
  never parsed or executed as a tool call. The independent MCP selector never
  sees skill instructions. Skills therefore cannot grant or widen capability.
- Only one applicable skill is resolved per run, as a complete NFC UTF-8 block
  under 8,192 bytes. The block is never partially truncated.
- `SIGILIX_SKILLS_MODE=off` is the incident-response circuit breaker. Missing or
  malformed policy also fails closed to no skill guidance, without failing the
  user's run.

## Migration ledger

1. `migrations/0017_create_org_skill_policy.sql` — installation-scoped skill
   enablement, surface policy, optimistic version, actor, and revoke timestamps.

## Threat model

| Threat | Boundary and mitigation |
| --- | --- |
| Compromised tenant admin | May toggle only compiled IDs for their verified installation; cannot add text, tools, or cross-tenant policy. |
| Compromised upstream publisher | A remote change has no runtime effect. Updating a pin, hash, or derived excerpt requires a reviewed code change. |
| Malicious or mistaken excerpt | Independent code and security review plus instruction-hash tests gate the compiled text; the global kill switch removes all injection. |
| Model behavior drift or prompt injection | Skill-influenced calls have no tools or execution parser, so model text cannot cross the capability boundary. |
| Confused-deputy tenant selection | The edge derives and verifies the installation; the run passes that server-owned integer internally, and D1 binds every read to it. |
| Revocation race | D1 policy writes are primary SQLite updates. Revoke increments the version and disables every surface; stale conditional writes conflict. A run records the policy snapshot it actually used. |
| Store outage or malformed row | Runtime logs a distinct bounded status and proceeds with zero skill guidance; it never serves cached or partially parsed policy. |
