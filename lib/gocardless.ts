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

// The scheme the money is asked for on. Left to GoCardless, the hosted page is
// free to offer the account's other payment options - which is how a shopper who
// picked "Instant Bank Pay" ended up being offered a card. Naming the scheme
// pins the request to a bank-to-bank transfer and nothing else. A currency with
// no open-banking scheme of its own is left unset rather than guessed at, since
// an invalid scheme would fail the request outright.
export function instantBankSchemeFor(currency: string): string | null {
  switch (currency.toUpperCase()) {
    case 'GBP': return 'faster_payments'
    case 'EUR': return 'sepa_credit_transfer'
    default: return null
  }
}

export async function createBillingRequest(input: {
  amount: number // pence
  currency: string
  description: string
  scheme?: string | null
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
            ...(input.scheme ? { scheme: input.scheme } : {}),
          },
        },
      },
    }
  )
  return mapBillingRequest(data.billing_requests)
}

// A billing request sits at `pending` until the shopper has actually authorised
// it in their bank; everything past that is money genuinely on its way, even in
// the gap before the payment resource exists. Worth the distinction because the
// absence of a payment id on its own says nothing about which of the two it is.
export function isBillingRequestAuthorised(status: string): boolean {
  return status === 'ready_to_fulfil' || status === 'fulfilling' || status === 'fulfilled'
}

export async function getBillingRequest(id: string): Promise<GcBillingRequest> {
  const data = await gcFetch<{ billing_requests: { id: string; status: string; links?: { payment_request_payment?: string } } }>(
    `/billing_requests/${encodeURIComponent(id)}`
  )
  return mapBillingRequest(data.billing_requests)
}

// --- Billing request flows (the hosted authorisation page) ----------------

export type GcBillingRequestFlow = { id: string; authorisationUrl: string }

// What the hosted page's "your details" step is filled in with before the
// shopper sees it. Everything here stays editable on the page - the details are
// a head start, not a lock (locking them would be `lock_customer_details`, which
// this module deliberately does not send: the shopper may well want to pay from
// an account in another name).
export type GcPrefilledCustomer = {
  email?: string
  given_name?: string
  family_name?: string
}

export async function createBillingRequestFlow(input: {
  billingRequestId: string
  redirectUri: string
  exitUri: string
  prefilledCustomer?: GcPrefilledCustomer
  idempotencyKey?: string
}): Promise<GcBillingRequestFlow> {
  const prefilled = input.prefilledCustomer
  const hasPrefill = !!prefilled && Object.values(prefilled).some((v) => !!v)

  const data = await gcFetch<{ billing_request_flows: { id: string; authorisation_url: string } }>(
    '/billing_request_flows',
    {
      method: 'POST',
      idempotencyKey: input.idempotencyKey,
      body: {
        billing_request_flows: {
          redirect_uri: input.redirectUri,
          exit_uri: input.exitUri,
          ...(hasPrefill ? { prefilled_customer: prefilled } : {}),
          links: { billing_request: input.billingRequestId },
        },
      },
    }
  )
  return { id: data.billing_request_flows.id, authorisationUrl: data.billing_request_flows.authorisation_url }
}

// --- Billing request actions & institutions --------------------------------
//
// The hosted GoCardless page walks the shopper through whatever actions are
// still outstanding on a billing request. Complete them here, from this site,
// and the hosted page has nothing left to ask - it goes straight to the bank.
//
// Not all of them can be done here, and deliberately so: creating the bank
// authorisation itself is only permitted from a GoCardless-hosted page, because
// that is where the regulated wording has to be shown. So the last hop is
// always theirs. What this buys is the two steps before it - who is paying, and
// which bank they are paying from - happening on the shop's own checkout.

// A bank the shopper can pay from. `iconUrl` is the square mark meant for a
// list; `logoUrl` is the wide one. Both are absolute URLs on GoCardless's own
// CDN, so they are rendered as plain images rather than optimised - there is
// nothing local to optimise.
export type GcInstitution = {
  id: string
  name: string
  iconUrl: string | null
  logoUrl: string | null
  countryCode: string | null
}

// The banks GoCardless will accept for THIS request, rather than every bank it
// knows about: the list is scoped to the billing request so a scheme the request
// cannot use never reaches the shopper as an option that then fails.
export async function listInstitutions(billingRequestId: string, countryCode: string): Promise<GcInstitution[]> {
  const data = await gcFetch<{ institutions: Array<{ id: string; name: string; icon_url?: string | null; logo_url?: string | null; country_code?: string | null }> }>(
    `/billing_requests/${encodeURIComponent(billingRequestId)}/institutions?country_code=${encodeURIComponent(countryCode)}`
  )
  return (data.institutions ?? []).map((i) => ({
    id: i.id,
    name: i.name,
    iconUrl: i.icon_url ?? null,
    logoUrl: i.logo_url ?? null,
    countryCode: i.country_code ?? null,
  }))
}

// GoCardless wants a name in two halves; a checkout collects it as one line. A
// name that does not split into two is left out entirely rather than guessed at,
// since a half-filled name would only have to be corrected at the bank.
export function splitCustomerName(fullName: string): { given_name?: string; family_name?: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean)
  if (parts.length < 2) return {}
  return { given_name: parts[0], family_name: parts.slice(1).join(' ') }
}

export type GcCustomerDetails = {
  email: string
  name: string
  addressLine1: string
  addressLine2?: string
  city: string
  region?: string
  postalCode: string
  countryCode: string
}

// Completes the request's `collect_customer_details` action - the "your details"
// step of the hosted page - from what the checkout already asked for.
export async function collectCustomerDetails(billingRequestId: string, details: GcCustomerDetails): Promise<void> {
  await gcFetch(`/billing_requests/${encodeURIComponent(billingRequestId)}/actions/collect_customer_details`, {
    method: 'POST',
    body: {
      data: {
        customer: {
          email: details.email,
          ...splitCustomerName(details.name),
        },
        customer_billing_detail: {
          address_line1: details.addressLine1,
          ...(details.addressLine2 ? { address_line2: details.addressLine2 } : {}),
          city: details.city,
          ...(details.region ? { region: details.region } : {}),
          postal_code: details.postalCode,
          country_code: details.countryCode,
        },
      },
    },
  })
}

// Completes the request's `select_institution` action - the bank picker on the
// hosted page - with the bank the shopper chose here instead.
export async function selectInstitution(billingRequestId: string, institution: string, countryCode: string): Promise<void> {
  await gcFetch(`/billing_requests/${encodeURIComponent(billingRequestId)}/actions/select_institution`, {
    method: 'POST',
    body: { data: { institution, country_code: countryCode } },
  })
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

// A chargeback reverses money that was already collected, so it needs to reach a
// PAID order (unlike an ordinary pre-settlement failure). The shop side maps this
// to a refunded/reversed state rather than a plain FAILED one.
export function isPaymentChargedBack(status: string): boolean {
  return status === 'charged_back'
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
