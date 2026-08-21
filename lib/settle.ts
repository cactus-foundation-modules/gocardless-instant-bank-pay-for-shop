// Shared confirmation logic used by both the redirect-return route and the
// webhook: given our payment row and the current GoCardless payment, move the
// shop order to its final state exactly once.
import { getOrderById, markOrderAwaitingConfirmation, markOrderPaid, markOrderPaymentFailed, setOrderPaymentReference } from '@/modules/shop/lib/db/orders'
import { getCheckoutDraft, materialiseDraftOrder } from '@/modules/shop/lib/checkout-draft'
import { fulfillPaidOrder } from '@/modules/shop/lib/order-fulfillment'
import { isPaymentChargedBack, isPaymentCollected, isPaymentFailed, type GcPayment } from '@/modules/gocardless-instant-bank-pay-for-shop/lib/gocardless'
import { updateGcpPayment, type GcpPayment } from '@/modules/gocardless-instant-bank-pay-for-shop/lib/db'

function toPence(amount: number): number {
  return Math.round(amount * 100)
}

/** Whether a settled payment is genuinely for this order: same money, same
 *  currency. Exported for the tests.
 *
 *  It exists because the check used to live in ONE of the two settlement paths.
 *  `confirmPayment` (the on-page confirm route) compared the figures and refused
 *  a mismatch; this function - which the webhook AND the redirect-return route
 *  both go through, and which is how most payments actually settle - marked the
 *  order PAID on the payment's status alone. So the guard was on the path least
 *  likely to be taken. */
export function paymentMatchesOrder(
  payment: Pick<GcPayment, 'amount' | 'currency'>,
  order: { total: unknown; currency: string },
): boolean {
  const expected = toPence(Number(order.total))
  if (!Number.isFinite(expected)) return false
  if (payment.amount !== expected) return false
  return payment.currency.toUpperCase() === order.currency.toUpperCase()
}

export async function settleFromPayment(row: GcpPayment, payment: GcPayment): Promise<void> {
  await updateGcpPayment(row.id, { paymentId: payment.id, status: payment.status })

  if (isPaymentFailed(payment.status)) {
    // Route both pre-settlement failures and post-settlement chargebacks through
    // the shop's status update. A chargeback (or a late `failed`) can land after
    // the order is already PAID, so we never skip on a PAID order - we pass the
    // reason and let the shop side transition PAID -> a visible reversed state
    // rather than silently dropping it (a plain FAILED handles the PENDING case).
    //
    // No order at all means the shopper never got far enough to have one, which
    // is the entire point of drafting them: a payment that fell over leaves
    // nothing behind, so there is nothing here to mark as failed.
    if (!(await getOrderById(row.orderId))) return
    const reason = isPaymentChargedBack(payment.status) ? 'CHARGEBACK' : 'FAILED'
    await markOrderPaymentFailed(row.orderId, reason)
    return
  }

  // Never fulfil - or create - on status alone. A payment whose amount or
  // currency does not match is not this order's payment, and honouring it would
  // ship goods against money that was never charged for them. Checked against
  // the order where there is one, and against the draft where there is not yet,
  // because the check has to happen BEFORE the order is brought into being.
  const target = (await getOrderById(row.orderId)) ?? (await getCheckoutDraft(row.orderId))
  if (!target) {
    console.error(`[gocardless-ibp] payment ${payment.id} settled against a missing order ${row.orderId}`)
    return
  }
  if (!paymentMatchesOrder(payment, target)) {
    // Left unfulfilled and loudly logged so a human looks at it - deliberately
    // not failed either, because on a collected payment the money HAS been taken
    // and telling the shopper their payment failed would be its own kind of
    // wrong.
    console.error(
      `[gocardless-ibp] payment ${payment.id} does not match order ${target.orderNumber}: ` +
      `collected ${payment.amount} ${payment.currency}, order expects ${toPence(Number(target.total))} ${target.currency}`,
    )
    return
  }

  // A GoCardless payment resource only exists once the shopper has authorised
  // the request at their bank, so by here the money is committed even if it has
  // not landed. That is the moment the order earns its existence. Idempotent, so
  // the redirect back and the webhook racing each other create exactly one.
  const order = await materialiseDraftOrder(row.orderId)
  if (!order) {
    console.error(`[gocardless-ibp] payment ${payment.id} could not be given an order (${row.orderId})`)
    return
  }

  if (!isPaymentCollected(payment.status)) {
    // Authorised and on its way, but not collected yet. The shopper sees the
    // "awaiting" state and the webhook flips it to PAID when the money arrives.
    // Never downgrade an order that is already PAID.
    const fresh = await getOrderById(order.id)
    if (fresh && fresh.paymentStatus !== 'PAID') await markOrderAwaitingConfirmation(order.id)
    return
  }

  await setOrderPaymentReference(order.id, payment.id)
  // markOrderPaid is idempotent (no-op once already PAID), so a replayed
  // webhook can't fulfil the order twice.
  const justPaid = await markOrderPaid(order.id, payment.id)
  if (justPaid) await fulfillPaidOrder(order.id)
}

/**
 * The order for a billing request that the shopper has authorised but for which
 * GoCardless has not created the payment resource yet.
 *
 * The gap between those two is real and can last minutes. The money is
 * committed - `isBillingRequestAuthorised` is what says so - so the order should
 * exist, but there is no payment to check it against and nothing to settle. This
 * brings it into being and parks it, and the payment settles it later.
 */
export async function settleFromAuthorisedRequest(orderId: string): Promise<void> {
  const order = await materialiseDraftOrder(orderId)
  if (!order) return
  const fresh = await getOrderById(order.id)
  if (fresh && fresh.paymentStatus !== 'PAID') await markOrderAwaitingConfirmation(order.id)
}
