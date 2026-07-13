export type SeatCapacityDecision =
  | { kind: "invalid_input" }
  | { kind: "no_op" }
  | { kind: "local_only" }
  | { kind: "expand_to"; quantity: number }

export interface SeatCapacityChangeInput {
  purchasedQuantity: number
  currentAssignedQuantity: number
  prospectiveAssignedQuantity: number
  requestedAssigned: boolean
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

/**
 * Decide whether one seat-assignment change also needs a provider capacity expansion.
 * Unassignments are always local: purchased Stripe quantity is never implicitly reduced.
 */
export function decideSeatCapacityChange(input: SeatCapacityChangeInput): SeatCapacityDecision {
  const { purchasedQuantity, currentAssignedQuantity, prospectiveAssignedQuantity, requestedAssigned } = input
  if (
    !Number.isSafeInteger(purchasedQuantity) ||
    purchasedQuantity <= 0 ||
    !isNonNegativeSafeInteger(currentAssignedQuantity) ||
    !isNonNegativeSafeInteger(prospectiveAssignedQuantity) ||
    typeof requestedAssigned !== "boolean"
  ) {
    return { kind: "invalid_input" }
  }

  if (prospectiveAssignedQuantity === currentAssignedQuantity) return { kind: "no_op" }
  if (
    (requestedAssigned && prospectiveAssignedQuantity < currentAssignedQuantity) ||
    (!requestedAssigned && prospectiveAssignedQuantity > currentAssignedQuantity)
  ) {
    return { kind: "invalid_input" }
  }
  if (!requestedAssigned || prospectiveAssignedQuantity <= purchasedQuantity) return { kind: "local_only" }
  return { kind: "expand_to", quantity: prospectiveAssignedQuantity }
}
