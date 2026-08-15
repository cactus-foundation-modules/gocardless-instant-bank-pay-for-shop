// Shared confirmation logic used by both the redirect-return route and the
// webhook: given our payment row and the current GoCardless payment, move the
// shop order to its final state exactly once.
import { getOrderById, markOrderPaid, markOrderPaymentFailed, setOrderPaymentReference } from '@/modules/shop/lib/db/orders'
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

  if (isPaymentCollected(payment.status)) {
    // Never fulfil on status alone. A collected payment whose amount or currency
    // does not match the order is not this order's payment, and marking it PAID
    // would ship goods against money that was never charged for them. Left
    // unfulfilled and loudly logged so a human looks at it - deliberately not
    // failed either, because the money HAS been collected and telling the
    // shopper their payment failed would be its own kind of wrong.
    const order = await getOrderById(row.orderId)
    if (!order) {
      console.error(`[gocardless-ibp] payment ${payment.id} settled against a missing order ${row.orderId}`)
      return
    }
    if (!paymentMatchesOrder(payment, order)) {
      console.error(
        `[gocardless-ibp] payment ${payment.id} does not match order ${order.orderNumber}: ` +
        `collected ${payment.amount} ${payment.currency}, order expects ${toPence(Number(order.total))} ${order.currency}`,
      )
      return
    }
    await setOrderPaymentReference(row.orderId, payment.id)
    // markOrderPaid is idempotent (no-op once already PAID), so a replayed
    // webhook can't fulfil the order twice.
    const justPaid = await markOrderPaid(row.orderId, payment.id)
    if (justPaid) await fulfillPaidOrder(row.orderId)
  } else if (isPaymentFailed(payment.status)) {
    // Route both pre-settlement failures and post-settlement chargebacks through
    // the shop's status update. A chargeback (or a late `failed`) can land after
    // the order is already PAID, so we never skip on a PAID order - we pass the
    // reason and let the shop side transition PAID -> a visible reversed state
    // rather than silently dropping it (a plain FAILED handles the PENDING case).
    const reason = isPaymentChargedBack(payment.status) ? 'CHARGEBACK' : 'FAILED'
    await markOrderPaymentFailed(row.orderId, reason)
  }
}
