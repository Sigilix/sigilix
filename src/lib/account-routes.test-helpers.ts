// Shared DB seeders for the account-routes test suites. Extracted from
// account-routes.test.ts to keep that file under the 1000-line budget
// (COMPLIANCE.md file-size rule); no behavior change.

import { insertApiKey, linkAccountTenant } from "@/src/lib/api-key-store"
import { sha256Hex } from "@/src/lib/auth-bearer"

export async function seedLiveIdentity(db: D1Database, userId: string, githubUserId: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO user_identity
        (user_id, github_user_id, providers, created_at, last_login_at)
       VALUES (?, ?, '["github"]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    )
    .bind(userId, githubUserId)
    .run()
}

export async function seedAccount(
  db: D1Database,
  args: { userId: string; githubUserId: string; login: string; email?: string },
): Promise<void> {
  const now = "2026-01-01T00:00:00Z"
  await db
    .prepare(
      "INSERT INTO user_identity (user_id, github_user_id, email, email_verified, name, providers, created_at, last_login_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?)",
    )
    .bind(args.userId, args.githubUserId, args.email ?? null, args.login, JSON.stringify(["github"]), now, now)
    .run()
  await db
    .prepare("INSERT INTO user_credential (user_id, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .bind(args.userId, "pbkdf2-sha256$1$x$y", now, now)
    .run()
  await db
    .prepare(
      "INSERT INTO user_profile (github_user_id, display_name, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(Number(args.githubUserId), args.login, '{"theme":"dark"}', now, now)
    .run()
  await linkAccountTenant(db, { githubUserId: args.githubUserId, installationId: 42, role: "owner", nowIso: now })
  await insertApiKey(db, {
    id: `key-${args.userId}`,
    keyHash: await sha256Hex(`plain-${args.userId}`),
    installationId: 42,
    createdBy: args.githubUserId,
    nowIso: now,
    name: "laptop",
  })
  await db
    .prepare("INSERT INTO usage_events (meter, installation_id, user_key, surface, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind("coding_agent", 42, `gh:${args.githubUserId}`, "cli", now)
    .run()
  await db
    .prepare(
      "INSERT INTO email_verification_token (token_hash, user_id, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(`tok-${args.userId}`, args.userId, args.email ?? "x@y.com", now, "2099-01-01T00:00:00Z")
    .run()
}
