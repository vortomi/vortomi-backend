import { describe, expect, it } from 'vitest'
import { addDays, billingState, caracasToday, chargeFor, suspendsOn, trialEndsOn, trialOver } from '../../src/modules/subscriptions/subscription-rules.ts'

const first = (nextDueOn: string) => ({ billingDay: null, nextDueOn, owedCents: 7900 })
const monthly = (nextDueOn: string, owedCents = 7900) => ({ billingDay: 5, nextDueOn, owedCents })

describe('the dates of a subscription', () => {
  it('suspends at 00:00 of the third day after the due day', () => {
    expect(suspendsOn('2026-12-05')).toBe('2026-12-08')
    expect(suspendsOn('2026-12-30')).toBe('2027-01-02')
    expect(addDays('2026-02-27', 2)).toBe('2026-03-01')
  })

  it('gives the first payment 3 days from the day the plan is assigned', () => {
    expect(billingState(first('2026-12-01'), '2026-12-01')).toBe('awaiting_first_payment')
    expect(billingState(first('2026-12-01'), '2026-12-03')).toBe('awaiting_first_payment')
    expect(billingState(first('2026-12-01'), '2026-12-04')).toBe('suspended')
  })

  it('is up to date, due soon, in grace and suspended around the due day', () => {
    expect(billingState(monthly('2026-12-05'), '2026-11-27')).toBe('active')
    expect(billingState(monthly('2026-12-05'), '2026-11-29')).toBe('due_soon')
    expect(billingState(monthly('2026-12-05'), '2026-12-05')).toBe('due_soon')
    expect(billingState(monthly('2026-12-05'), '2026-12-06')).toBe('grace')
    expect(billingState(monthly('2026-12-05'), '2026-12-07')).toBe('grace')
    expect(billingState(monthly('2026-12-05'), '2026-12-08')).toBe('suspended')
  })

  it('only paying the whole debt avoids it: nothing owed is up to date, any amount owed counts', () => {
    expect(billingState(monthly('2026-12-05', 0), '2026-12-20')).toBe('active')
    expect(billingState(monthly('2026-12-05', 100), '2026-12-08')).toBe('suspended')
  })

  it('gives a company 7 days to choose a plan, the day it goes live included', () => {
    expect(trialEndsOn('2026-11-24')).toBe('2026-11-30')
    expect(trialOver('2026-11-30', '2026-11-30')).toBe(false)
    expect(trialOver('2026-11-30', '2026-12-01')).toBe(true)
  })

  it('reads today in Caracas', () => {
    expect(caracasToday(new Date('2026-12-02T03:30:00Z'))).toBe('2026-12-01')
    expect(caracasToday(new Date('2026-12-02T04:30:00Z'))).toBe('2026-12-02')
  })

  it('prices the months with the tier they reach', () => {
    const discounts = { '1': 0, '3': 5, '6': 10, '12': 20 }
    expect(chargeFor(7900, discounts, 1)).toEqual({ discountPercent: 0, amountCents: 7900 })
    expect(chargeFor(7900, discounts, 4)).toEqual({ discountPercent: 5, amountCents: 30020 })
    expect(chargeFor(7900, discounts, 6)).toEqual({ discountPercent: 10, amountCents: 42660 })
    expect(chargeFor(7900, discounts, 12)).toEqual({ discountPercent: 20, amountCents: 75840 })
  })
})
