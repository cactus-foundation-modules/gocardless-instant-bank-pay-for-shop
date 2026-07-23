// The GoCardless Instant Bank Pay payment provider, registered into the shop
// checkout via the `shop.payment-providers` extension point (see the manifest).
import { getSiteUrl } from '@/lib/config/env'
import type {
  ShpOrderDraft, ShpPaymentIntent, ShpPaymentProvider, ShpPaymentResult, ShpRefundRequest, ShpRefundResult,
} from '@/modules/shop/lib/payments/provider'
import { isGoCardlessConfigured } from '@/modules/gocardless-instant-bank-pay-for-shop/lib/env'
import { getGoCardlessSettings } from '@/modules/gocardless-instant-bank-pay-for-shop/lib/settings'
import * as gc from '@/modules/gocardless-instant-bank-pay-for-shop/lib/gocardless'
import { createGcpPayment, getGcpPaymentByOrderId, updateGcpPayment } from '@/modules/gocardless-instant-bank-pay-for-shop/lib/db'

const METHOD_ID = 'GOCARDLESS_IBP'
const RETURN_PATH = '/api/m/gocardless-instant-bank-pay-for-shop/return'

function toPence(amount: number): number {
  return Math.round(amount * 100)
}

// Offered at checkout only when the credentials are set AND the admin has turned
// the method on in its settings tab.
async function isAvailable(): Promise<boolean> {
  if (!isGoCardlessConfigured()) return false
  const settings = await getGoCardlessSettings()
  return settings.enabled
}

async function createIntent(order: ShpOrderDraft): Promise<ShpPaymentIntent> {
  const settings = await getGoCardlessSettings()
  const prefix = settings.paymentDescription.trim()
  const description = prefix ? `${prefix} (${order.orderNumber})` : `Order ${order.orderNumber}`

  const billingRequest = await gc.createBillingRequest({
    amount: toPence(order.amount),
    currency: order.currency.toUpperCase(),
    description,
    idempotencyKey: `gcp-br-${order.orderId}`,
  })

  const siteUrl = getSiteUrl()
  const flow = await gc.createBillingRequestFlow({
    billingRequestId: billingRequest.id,
    redirectUri: `${siteUrl}${RETURN_PATH}?order=${encodeURIComponent(order.orderId)}`,
    exitUri: `${siteUrl}/shop/checkout`,
    idempotencyKey: `gcp-brf-${order.orderId}`,
  })

  await createGcpPayment({
    orderId: order.orderId,
    orderNumber: order.orderNumber,
    billingRequestId: billingRequest.id,
    billingRequestFlowId: flow.id,
    amount: order.amount,
    currency: order.currency,
  })

  return { approvalUrl: flow.authorisationUrl, providerOrderId: billingRequest.id }
}

// Best-effort confirmation for the on-page confirm route. The redirect-return
// route and webhook are the real confirmation path; this simply reports whether
// the payment has settled yet, re-validating amount/currency and never trusting
// the client payload.
async function confirmPayment(order: ShpOrderDraft): Promise<ShpPaymentResult> {
  const row = await getGcpPaymentByOrderId(order.orderId)
  if (!row?.billingRequestId) return { success: false, error: 'No GoCardless payment was found for this order.' }

  const billingRequest = await gc.getBillingRequest(row.billingRequestId)
  if (!billingRequest.paymentId) {
    // Not authorised/fulfilled yet - the webhook will confirm it.
    return { success: true, pending: true, providerReference: row.billingRequestId }
  }

  const payment = await gc.getPayment(billingRequest.paymentId)
  if (payment.amount !== toPence(order.amount)) return { success: false, error: 'Payment amount does not match this order.' }
  if (payment.currency.toUpperCase() !== order.currency.toUpperCase()) return { success: false, error: 'Payment currency does not match this order.' }

  await updateGcpPayment(row.id, { paymentId: payment.id, status: payment.status })
  if (gc.isPaymentFailed(payment.status)) return { success: false, error: 'The bank payment did not go through.' }
  return { success: true, pending: !gc.isPaymentCollected(payment.status), providerReference: payment.id }
}

async function refundOrder(refund: ShpRefundRequest): Promise<ShpRefundResult> {
  try {
    if (!refund.providerReference) return { success: false, error: 'No GoCardless payment reference to refund against.' }
    const payment = await gc.getPayment(refund.providerReference)

    // Re-validate against what was actually captured before issuing (never trust
    // the request alone): a currency mismatch or an over-refund is rejected here
    // rather than handed to GoCardless.
    if (refund.currency.toUpperCase() !== payment.currency.toUpperCase()) {
      return { success: false, error: 'Refund currency does not match the original payment.' }
    }
    const amountPence = toPence(refund.amount)
    if (amountPence <= 0) return { success: false, error: 'Refund amount must be greater than zero.' }
    const refundablePence = payment.amount - payment.amountRefunded
    if (amountPence > refundablePence) {
      return { success: false, error: 'Refund amount exceeds the amount still refundable on this payment.' }
    }

    // total_amount_confirmation must equal all confirmed refunds for the payment
    // (existing + this one), so derive it from the payment's own amount_refunded.
    // The idempotency key (a deterministic key supplied by the shop refund route)
    // stops a retried/double refund executing twice on GoCardless.
    const result = await gc.createRefund({
      paymentId: refund.providerReference,
      amount: amountPence,
      totalAmountConfirmation: payment.amountRefunded + amountPence,
      idempotencyKey: refund.idempotencyKey,
    })
    return { success: true, providerRefundId: result.id }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'GoCardless refund failed' }
  }
}

export const gocardlessIbpProvider: ShpPaymentProvider = {
  id: METHOD_ID,
  label: 'Instant Bank Pay',
  confirmMode: 'auto',
  isAvailable,
  createIntent,
  confirmPayment,
  refundOrder,
}
