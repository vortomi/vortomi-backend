import type { BusinessDay } from '../../db/schema/index.ts'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Weekday (0 = Sunday, as the panel stores it) and "HH:MM" of an instant on the company's clock. */
function localClock(at: Date, timeZone: string): { day: number; time: string } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? ''
  return { day: WEEKDAYS.indexOf(part('weekday')), time: `${part('hour')}:${part('minute')}` }
}

/**
 * Whether the company attends at `at`, by its schedule and time zone. A company that never set
 * a schedule counts as always open: there is nothing to announce. A day missing from the
 * schedule, or without hours, is closed. Closing time itself is already outside.
 */
export function isOpenAt(hours: readonly BusinessDay[], at: Date, timeZone: string): boolean {
  if (!hours.length) return true
  const { day, time } = localClock(at, timeZone)
  const today = hours.find((h) => h.day === day)
  return !!today?.open && !!today.close && time >= today.open && time < today.close
}
