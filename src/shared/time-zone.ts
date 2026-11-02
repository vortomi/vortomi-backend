import { z } from 'zod'

/** An IANA time zone the runtime knows ("America/Caracas"); reports and the 24 h window use it. */
export const timeZone = z.string().refine((zone) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone })
    return true
  } catch {
    return false
  }
}, 'Unknown time zone')

/** The calendar day of an instant in a time zone: "2026-11-02". */
export const dayIn = (at: Date, zone: string): string => new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(at)
