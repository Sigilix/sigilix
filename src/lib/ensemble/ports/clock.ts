// Port: the `Date.now()` seam. Injecting a clock keeps domain time-math pure and
// unit-testable (no wall-clock dependency in policy code). Types only.

export interface ClockPort {
  /** Current epoch milliseconds. The injected `Date.now()` seam. */
  now(): number
}
