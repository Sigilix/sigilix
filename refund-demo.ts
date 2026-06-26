// refund-demo.ts — prorated refund helper

/**
 * Prorated refund: refund the UNUSED fraction of the 30-day period.
 * e.g. used 10 of 30 days on a $100 order -> refund $66.67.
 */
export function proratedRefund(amountCents: number, daysUsed: number): number {
  const daysLeft = 30 - daysUsed
  return Math.floor((amountCents * daysLeft) / 30)
}
