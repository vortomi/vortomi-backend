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
