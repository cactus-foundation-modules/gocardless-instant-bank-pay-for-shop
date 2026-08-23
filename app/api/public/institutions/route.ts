// GET /api/m/gocardless-instant-bank-pay-for-shop/public/institutions?order=...&country=GB
//
// The banks the shopper can pay from, for the checkout's own bank picker. Public
// because the checkout is: the only thing it needs to know is which billing
// request to scope the list to, and it gets that from the draft order id the
// payment intent already handed the browser.
//
// Nothing here moves money, changes anything, or says anything about the order.
// The worst a guessed id can do is list the same banks everyone else is offered.
import { NextRequest, NextResponse } from 'next/server'
import { checkInMemoryRateLimit, getClientIpFromRequest } from '@/modules/shop/lib/rate-limit'
import { isGoCardlessConfigured } from '@/modules/gocardless-instant-bank-pay-for-shop/lib/env'
import { getGcpPaymentByOrderId } from '@/modules/gocardless-instant-bank-pay-for-shop/lib/db'
import * as gc from '@/modules/gocardless-instant-bank-pay-for-shop/lib/gocardless'

// The list of banks for a country barely changes from one week to the next, and
// every shopper who reaches the payment step asks for the same one. Held per
// serverless instance for a few minutes so a busy checkout is not a queue of
// identical calls to GoCardless.
//
// Keyed by country alone. The list is scoped to a billing request upstream, but
// every request this module makes is the same shape - a one-off open banking
// payment on the scheme for the shop's own currency - so two shoppers in the
// same country are always offered the same banks.
const CACHE_TTL_MS = 5 * 60 * 1000
const cache = new Map<string, { at: number; institutions: gc.GcInstitution[] }>()

export async function GET(request: NextRequest) {
  const ip = getClientIpFromRequest(request)
  if (!checkInMemoryRateLimit(`gcp-institutions:${ip}`, 30, 15 * 60 * 1000)) {
    return NextResponse.json({ error: 'Too many attempts, please try again in a little while.' }, { status: 429 })
  }

  if (!isGoCardlessConfigured()) return NextResponse.json({ institutions: [] })

  const orderId = request.nextUrl.searchParams.get('order') ?? ''
  const country = (request.nextUrl.searchParams.get('country') ?? 'GB').toUpperCase()
  if (!/^[A-Z]{2}$/.test(country)) return NextResponse.json({ error: 'Invalid country.' }, { status: 400 })

  const row = orderId ? await getGcpPaymentByOrderId(orderId) : null
  if (!row?.billingRequestId) return NextResponse.json({ error: 'No payment was found for this order.' }, { status: 404 })

  const cached = cache.get(country)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return NextResponse.json({ institutions: cached.institutions })
  }

  try {
    const institutions = await gc.listInstitutions(row.billingRequestId, country)
    cache.set(country, { at: Date.now(), institutions })
    return NextResponse.json({ institutions })
  } catch (err) {
    // An empty list is not an error the shopper needs to see: the hosted page
    // asks which bank they want anyway, so the checkout simply says so and
    // carries on. Logged, because a list that never loads is worth knowing about.
    console.error('[gocardless-ibp] could not list institutions', err)
    return NextResponse.json({ institutions: [] })
  }
}
