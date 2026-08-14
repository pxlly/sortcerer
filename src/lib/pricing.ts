/** Trybit invoice amounts (USD). First payment = setup; renewals = monthly. */
export const SETUP_FEE_USD = 300;
export const MONTHLY_USD = 175;

export function invoiceAmountUsd(setupPaid: boolean): number {
  return setupPaid ? MONTHLY_USD : SETUP_FEE_USD;
}
