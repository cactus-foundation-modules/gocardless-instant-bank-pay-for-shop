// POST /api/m/gocardless-instant-bank-pay-for-shop/webhook
// GoCardless calls this when a billing request is fulfilled or a payment
// changes state. Signature-verified; no session (GoCardless is the caller).
import { NextRequest, NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'crypto'
import { getGoCardlessWebhookSecret } from '@/modules/gocardless-instant-bank-pay-for-shop/lib/env'
import * as gc from '@/modules/gocardless-instant-bank-pay-for-shop/lib/gocardless'
import { getGcpPaymentByBillingRequestId, getGcpPaymentByPaymentId } from '@/modules/gocardless-instant-bank-pay-for-shop/lib/db'
import { settleFromPayment } from '@/modules/gocardless-instant-bank-pay-for-shop/lib/settle'

// GoCardless signs the raw body with HMAC-SHA256 using the webhook endpoint
// secret and sends it hex-encoded in the Webhook-Signature header.
function verifySignature(rawBody: string, signature: string, secret: string): boolean {
  if (!signature) return false
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

type GcWebhookEvent = { resource_type?: string; action?: string; links?: { billing_request?: string; payment?: string } }

async function handleEvent(event: GcWebhookEvent): Promise<void> {
  const links = event.links ?? {}

  if (event.resource_type === 'billing_requests' && links.billing_request) {
    const row = await getGcpPaymentByBillingRequestId(links.billing_request)
    if (!row) return
    const billingRequest = await gc.getBillingRequest(links.billing_request)
    // A payment only exists once the request is fulfilled; before that there is
    // nothing to settle.
    if (billingRequest.paymentId) {
      const payment = await gc.getPayment(billingRequest.paymentId)
      await settleFromPayment(row, payment)
    }
    return
  }

  if (event.resource_type === 'payments' && links.payment) {
    // Resolved by payment id, which the return route or the billing_requests
    // event links onto the row first; if it isn't linked yet, skip - the
    // billing_requests.fulfilled event settles it.
    const row = await getGcpPaymentByPaymentId(links.payment)
    if (!row) return
    const payment = await gc.getPayment(links.payment)
    await settleFromPayment(row, payment)
  }
}

export async function POST(request: NextRequest) {
  const secret = getGoCardlessWebhookSecret()
  if (!secret) return new NextResponse('Not configured', { status: 503 })

  const rawBody = await request.text()
  const signature = request.headers.get('webhook-signature') ?? ''
  if (!verifySignature(rawBody, signature, secret)) {
    return new NextResponse('Invalid signature', { status: 403 })
  }

  let parsed: { events?: GcWebhookEvent[] }
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return new NextResponse('Invalid payload', { status: 400 })
  }

  const events = Array.isArray(parsed.events) ? parsed.events : []
  for (const event of events) {
    // One poison event must not fail the whole batch (GoCardless would retry the
    // lot); each is idempotent, so swallow and carry on.
    try {
      await handleEvent(event)
    } catch (err) {
      console.error('[gocardless-ibp] webhook event failed', err)
    }
  }

  return NextResponse.json({ ok: true })
}
