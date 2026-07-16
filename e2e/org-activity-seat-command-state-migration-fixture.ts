export function commandSql(args: {
  deliveryId: string
  payload: string
  installationId?: number
  targetId?: string
  actorId?: string
  receivedAtMs?: number
}): string {
  return `INSERT INTO org_activity_seat_command (
    delivery_id, payload_sha256, installation_id, repository_id, pr_number,
    head_sha, action, target_github_user_id, target_login,
    actor_github_user_id, actor_login, author_association, received_at_ms
  ) VALUES (
    '${args.deliveryId}', '${args.payload}', ${args.installationId ?? 42}, 9001, 7,
    '${"b".repeat(40)}', 'opened', '${args.targetId ?? "111"}', 'target',
    '${args.actorId ?? "222"}', 'actor', 'MEMBER', ${args.receivedAtMs ?? 100}
  )`
}

export function operationSql(args: {
  operationId: string
  installationId: number
  kind?: "activity_github" | "managed_github"
  targetId?: string
  actorId?: string
  state?: "pending" | "canceled"
  subscriptionId?: string
  subscriptionItemId?: string
  idempotencyKey?: string
  createdAtMs?: number
  revision: number
}): string {
  const kind = args.kind ?? "activity_github"
  const state = args.state ?? "pending"
  const terminal = state === "canceled"
  return `INSERT INTO org_seat_billing_operation (
    operation_id, installation_id, revision, login, target_identity_kind,
    target_github_user_id, activity_actor_github_user_id, actor_login, target_is_admin,
    requested_assigned, previous_assigned, desired_quantity, state,
    stripe_subscription_id, stripe_subscription_item_id, stripe_observed_quantity,
    idempotency_key, attempts, error_code, next_attempt_at_ms, created_at_ms,
    updated_at_ms, stripe_applied_at_ms, completed_at_ms
  ) VALUES (
    '${args.operationId}', ${args.installationId}, ${args.revision}, 'target', '${kind}',
    '${args.targetId ?? "111"}', ${kind === "activity_github" ? `'${args.actorId ?? "222"}'` : "NULL"},
    'actor', 0, 1, 0, 3, '${state}', '${args.subscriptionId ?? `sub_${args.installationId}`}',
    '${args.subscriptionItemId ?? `si_${args.installationId}`}',
    ${terminal ? "NULL" : "2"}, '${args.idempotencyKey ?? `${args.operationId}-key`}', 0,
    ${terminal ? "'test_terminal'" : "NULL"},
    ${terminal ? "NULL" : "500"}, ${args.createdAtMs ?? 400}, ${args.createdAtMs ?? 400},
    NULL, ${terminal ? String((args.createdAtMs ?? 400) + 50) : "NULL"}
  )`
}
