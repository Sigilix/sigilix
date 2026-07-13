import { describe, expect, it } from "vitest"
import { decideSeatCapacityChange } from "./seat-capacity"

describe("decideSeatCapacityChange", () => {
  it("is a no-op when the prospective assignment count is unchanged", () => {
    expect(
      decideSeatCapacityChange({
        purchasedQuantity: 4,
        currentAssignedQuantity: 3,
        prospectiveAssignedQuantity: 3,
        requestedAssigned: true,
      }),
    ).toEqual({ kind: "no_op" })
  })

  it("keeps assignment local while purchased capacity covers the prospective count", () => {
    expect(
      decideSeatCapacityChange({
        purchasedQuantity: 4,
        currentAssignedQuantity: 3,
        prospectiveAssignedQuantity: 4,
        requestedAssigned: true,
      }),
    ).toEqual({ kind: "local_only" })
  })

  it("expands to the prospective count only when an assignment exceeds purchased capacity", () => {
    expect(
      decideSeatCapacityChange({
        purchasedQuantity: 4,
        currentAssignedQuantity: 4,
        prospectiveAssignedQuantity: 5,
        requestedAssigned: true,
      }),
    ).toEqual({ kind: "expand_to", quantity: 5 })
  })

  it("never shrinks purchased capacity when a seat is unassigned", () => {
    expect(
      decideSeatCapacityChange({
        purchasedQuantity: 8,
        currentAssignedQuantity: 5,
        prospectiveAssignedQuantity: 4,
        requestedAssigned: false,
      }),
    ).toEqual({ kind: "local_only" })
  })

  it("rejects invalid counts and assignment-direction mismatches", () => {
    for (const input of [
      {
        purchasedQuantity: 0,
        currentAssignedQuantity: 0,
        prospectiveAssignedQuantity: 1,
        requestedAssigned: true,
      },
      {
        purchasedQuantity: 2.5,
        currentAssignedQuantity: 1,
        prospectiveAssignedQuantity: 2,
        requestedAssigned: true,
      },
      {
        purchasedQuantity: 2,
        currentAssignedQuantity: -1,
        prospectiveAssignedQuantity: 0,
        requestedAssigned: true,
      },
      {
        purchasedQuantity: 2,
        currentAssignedQuantity: 1,
        prospectiveAssignedQuantity: 2,
        requestedAssigned: false,
      },
      {
        purchasedQuantity: 2,
        currentAssignedQuantity: 2,
        prospectiveAssignedQuantity: 1,
        requestedAssigned: true,
      },
    ]) {
      expect(decideSeatCapacityChange(input)).toEqual({ kind: "invalid_input" })
    }
  })
})
