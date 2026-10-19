/** WhatsApp only allows free-form messages within 24 h of the customer's last message. */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * A timestamp slightly in the future (clock skew between Meta and this server)
 * counts as inside the window.
 */
export function isWithinServiceWindow(lastInboundAt: Date | null, now: Date): boolean {
  if (!lastInboundAt) return false
  return now.getTime() - lastInboundAt.getTime() < SERVICE_WINDOW_MS
}
