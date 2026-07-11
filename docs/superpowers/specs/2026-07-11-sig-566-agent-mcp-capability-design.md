# SIG-566 — run-bound agent MCP capability

## Scope

Agent runs may use the tenant's currently approved MCP **read** tools without
receiving provider OAuth credentials. The Worker authorizes the exact GitHub
repository installation, snapshots a bounded set of approved grant/tool tuples,
and gives the trusted container only an opaque, short-lived capability plus the
Worker machine endpoint. MCP failure is fail-soft: coding continues without the
connected context.

This slice does not add MCP writes and does not expose PR-review evidence as an
agent tool.

## Security boundary

- `AgentMcpCapabilityDO` has one instance per UUID run id. It persists only the
  capability SHA-256 digest, exact installation/repository/surface binding,
  curated grant/tool tuples, expiry, and the global four-call budget.
- The public machine route derives the tenant broker from the persisted
  installation id; callers cannot submit an installation, grant, vendor, or
  provider endpoint.
- The tenant broker re-reads the active grant and owner ceiling before and after
  every provider read. A revoke or policy narrowing while the call is in flight
  discards the provider result before it reaches the agent.
- The minimal engine calls the machine route from the trusted parent. The full
  CLI child sees only an ephemeral loopback MCP URL; the parent bridge injects
  the capability upstream.
- Terminal dispatch revokes the capability in `finally`; the Durable Object
  alarm is crash recovery for missed cleanup.

## Bounds

- 16 curated read tools per run
- 4 successful invoke admissions globally per run
- 8 catalog reads per run
- 16 KiB request and 256 KiB broker/result limits
- 12 second MCP hop timeout
- capability TTL clamped to 30 seconds–15 minutes and never longer than the run
  timeout used to mint it

## Migration ledger

The list is forward-only. Do not edit or reorder this tag after it is applied.

| Order | Ticket | Kind | Tag | What it does | Apply |
|---|---|---|---|---|---|
| 1 | SIG-566 | Durable Object | `sig-566-agent-mcp-capability-v1` | Registers the SQLite-backed per-run capability and expiry-alarm state | One-time `wrangler deploy` before versioned deploys |
