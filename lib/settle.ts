// Shared confirmation logic used by both the redirect-return route and the
// webhook: given our payment row and the current GoCardless payment, move the
// shop order to its final state exactly once.
import { markOrderPaid, markOrderPaymentFailed, setOrderPaymentReference } from '@/modules/shop/lib/db/orders'
import { fulfillPaidOrder } from '@/modules/shop/lib/order-fulfillment'
import { isPaymentChargedBack, isPaymentCollected, isPaymentFailed, type GcPayment } from '@/modules/gocardless-instant-bank-pay-for-shop/lib/gocardless'
import { updateGcpPayment, type GcpPayment } from '@/modules/gocardless-instant-bank-pay-for-shop/lib/db'

export async function settleFromPayment(row: GcpPayment, payment: GcPayment): Promise<void> {
  await updateGcpPayment(row.id, { paymentId: payment.id, status: payment.status })

  if (isPaymentCollected(payment.status)) {
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
