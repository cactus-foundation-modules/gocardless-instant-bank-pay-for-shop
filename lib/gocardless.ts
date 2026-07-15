// Thin GoCardless REST client. No SDK dependency - the handful of Billing
// Requests / Payments / Refunds calls this module needs are plain REST.
// API reference: https://developer.gocardless.com/api-reference/
import { getGoCardlessAccessToken, getGoCardlessApiBase } from '@/modules/gocardless-instant-bank-pay-for-shop/lib/env'

const GC_VERSION = '2015-07-06'

type GcFetchInit = { method?: string; body?: unknown; idempotencyKey?: string }

async function gcFetch<T>(path: string, init: GcFetchInit = {}): Promise<T> {
  const token = getGoCardlessAccessToken()
  if (!token) throw new Error('GoCardless is not configured')

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'GoCardless-Version': GC_VERSION,
    Accept: 'application/json',
  }
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'
  // Idempotency keys stop a retried POST creating a duplicate resource.
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey

  const res = await fetch(`${getGoCardlessApiBase()}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  })

  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
    throw new Error(detail?.error?.message ?? `GoCardless API error ${res.status}`)
  }
  return (await res.json()) as T
}

// --- Billing requests -----------------------------------------------------

export type GcBillingRequest = {
  id: string
  status: string
  // Once fulfilled, the created payment is linked here.
  paymentId: string | null
}

function mapBillingRequest(raw: { id: string; status: string; links?: { payment_request_payment?: string } }): GcBillingRequest {
  return { id: raw.id, status: raw.status, paymentId: raw.links?.payment_request_payment ?? null }
}

export async function createBillingRequest(input: {
  amount: number // pence
  currency: string
  description: string
  idempotencyKey?: string
}): Promise<GcBillingRequest> {
  const data = await gcFetch<{ billing_requests: { id: string; status: string; links?: { payment_request_payment?: string } } }>(
    '/billing_requests',
    {
      method: 'POST',
      idempotencyKey: input.idempotencyKey,
      body: {
        billing_requests: {
          payment_request: {
            description: input.description,
            amount: String(input.amount),
            currency: input.currency,
          },
        },
      },
    }
  )
  return mapBillingRequest(data.billing_requests)
}

export async function getBillingRequest(id: string): Promise<GcBillingRequest> {
  const data = await gcFetch<{ billing_requests: { id: string; status: string; links?: { payment_request_payment?: string } } }>(
    `/billing_requests/${encodeURIComponent(id)}`
  )
  return mapBillingRequest(data.billing_requests)
}

// --- Billing request flows (the hosted authorisation page) ----------------

export type GcBillingRequestFlow = { id: string; authorisationUrl: string }

export async function createBillingRequestFlow(input: {
  billingRequestId: string
  redirectUri: string
  exitUri: string
  idempotencyKey?: string
}): Promise<GcBillingRequestFlow> {
  const data = await gcFetch<{ billing_request_flows: { id: string; authorisation_url: string } }>(
    '/billing_request_flows',
    {
      method: 'POST',
      idempotencyKey: input.idempotencyKey,
      body: {
        billing_request_flows: {
          redirect_uri: input.redirectUri,
          exit_uri: input.exitUri,
          links: { billing_request: input.billingRequestId },
        },
      },
    }
  )
  return { id: data.billing_request_flows.id, authorisationUrl: data.billing_request_flows.authorisation_url }
}

// --- Payments -------------------------------------------------------------

export type GcPayment = {
  id: string
  status: string // pending_submission | submitted | confirmed | paid_out | failed | cancelled | charged_back
  amount: number // pence
  currency: string
  amountRefunded: number // pence
}

// The money has actually been collected once a payment is confirmed or paid out.
export function isPaymentCollected(status: string): boolean {
  return status === 'confirmed' || status === 'paid_out'
}

export function isPaymentFailed(status: string): boolean {
  return status === 'failed' || status === 'cancelled' || status === 'charged_back'
}

export async function getPayment(id: string): Promise<GcPayment> {
  const data = await gcFetch<{ payments: { id: string; status: string; amount: number; currency: string; amount_refunded?: number } }>(
    `/payments/${encodeURIComponent(id)}`
  )
  const p = data.payments
  return { id: p.id, status: p.status, amount: p.amount, currency: p.currency, amountRefunded: p.amount_refunded ?? 0 }
}

// Cheap authenticated call used to check the access token works (and points at
// the expected environment). Throws on failure.
export async function verifyCredentials(): Promise<void> {
  await gcFetch('/payments?limit=1')
}

// --- Refunds --------------------------------------------------------------

export async function createRefund(input: {
  paymentId: string
  amount: number // pence
  totalAmountConfirmation: number // pence: existing refunds + this one
  idempotencyKey?: string
}): Promise<{ id: string }> {
  const data = await gcFetch<{ refunds: { id: string } }>('/refunds', {
    method: 'POST',
    idempotencyKey: input.idempotencyKey,
    body: {
      refunds: {
        amount: input.amount,
        total_amount_confirmation: input.totalAmountConfirmation,
        links: { payment: input.paymentId },
      },
    },
  })
  return { id: data.refunds.id }
}
