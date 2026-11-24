/**
 * Whether an unpaid company is actually suspended (every panel screen but Suscripción closed, the
 * bot silent). Off until companies can pay from the panel (stages 3 and 4 of documentations/18):
 * nobody may be locked out with no way to pay. Set once at start (env BILLING_ENFORCEMENT=on);
 * tests switch it to check the rule. The dates and the reminders work either way.
 */
let enforced = false

export function setBillingEnforcement(on: boolean): void {
  enforced = on
}

export function billingEnforced(): boolean {
  return enforced
}
