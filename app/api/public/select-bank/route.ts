// POST /api/m/gocardless-instant-bank-pay-for-shop/public/select-bank
//
// The two steps of the hosted GoCardless flow that can be done on this site:
// which bank the shopper is paying from, and who they are. Both are recorded
// against the billing request, so the hosted page arrives with them already
// answered and goes straight to the bank.
//
// The third step - the bank authorisation itself - is not here and cannot be:
// GoCardless only permits it from their own page, because that is where the
// regulated wording is shown. See lib/gocardless.ts.
//
// Public, like the checkout that calls it. It moves no money and changes nothing
// about the order: the amount, the currency and the description were all set
// server-side when the billing request was created, and none of them can be
// touched from here.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { checkInMemoryRateLimit, getClientIpFromRequest } from '@/modules/shop/lib/rate-limit'
import { isGoCardlessConfigured } from '@/modules/gocardless-instant-bank-pay-for-shop/lib/env'
import { getGcpPaymentByOrderId } from '@/modules/gocardless-instant-bank-pay-for-shop/lib/db'
import * as gc from '@/modules/gocardless-instant-bank-pay-for-shop/lib/gocardless'

const Body = z.object({
  orderId: z.string().min(1),
  institution: z.string().min(1).max(120),
  countryCode: z.string().regex(/^[A-Za-z]{2}$/),
  // Who is paying, as the checkout has them. Only ever used to fill in the
  // "your details" step so the shopper does not have to type it twice.
  payer: z.object({
    email: z.string().email(),
    name: z.string().min(1).max(200),
    addressLine1: z.string().min(1).max(200),
    addressLine2: z.string().max(200).optional(),
    city: z.string().min(1).max(120),
    region: z.string().max(120).optional(),
    postalCode: z.string().min(1).max(20),
  }).optional(),
})

export async function POST(request: NextRequest) {
  const ip = getClientIpFromRequest(request)
  if (!checkInMemoryRateLimit(`gcp-select-bank:${ip}`, 30, 15 * 60 * 1000)) {
    return NextResponse.json({ error: 'Too many attempts, please try again in a little while.' }, { status: 429 })
  }

  if (!isGoCardlessConfigured()) return NextResponse.json({ error: 'This payment method is not available.' }, { status: 400 })

  const parsed = Body.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 400 })
  const { orderId, institution, payer } = parsed.data
  const countryCode = parsed.data.countryCode.toUpperCase()

  const row = await getGcpPaymentByOrderId(orderId)
  if (!row?.billingRequestId) return NextResponse.json({ error: 'No payment was found for this order.' }, { status: 404 })

  // A request the shopper has already authorised must not have its bank changed
  // underneath it. Nothing here could redirect the money, but re-answering a
  // settled request would only ever produce a confusing error from GoCardless.
  if (row.paymentId) return NextResponse.json({ error: 'This payment has already been authorised.' }, { status: 409 })

  try {
    await gc.selectInstitution(row.billingRequestId, institution, countryCode)
  } catch (err) {
    console.error('[gocardless-ibp] could not select institution', err)
    return NextResponse.json({ error: 'That bank could not be selected. You can choose it on the next screen instead.' }, { status: 502 })
  }

  // Best effort, and on purpose. A bank that was chosen successfully is worth
  // keeping even if the address will not do: the hosted page simply asks for
  // the details it is missing, which is exactly what it did before any of this
  // existed. Failing the whole call here would throw away the useful half.
  if (payer) {
    try {
      await gc.collectCustomerDetails(row.billingRequestId, {
        email: payer.email,
        name: payer.name,
        addressLine1: payer.addressLine1,
        addressLine2: payer.addressLine2,
        city: payer.city,
        region: payer.region,
        postalCode: payer.postalCode,
        countryCode,
      })
    } catch (err) {
      console.error('[gocardless-ibp] could not pre-fill customer details', err)
    }
  }

  return NextResponse.json({ ok: true })
}
