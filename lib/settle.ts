// Shared confirmation logic used by both the redirect-return route and the
// webhook: given our payment row and the current GoCardless payment, move the
// shop order to its final state exactly once.
import { markOrderPaid, markOrderPaymentFailed, setOrderPaymentReference } from '@/modules/shop/lib/db/orders'
import { fulfillPaidOrder } from '@/modules/shop/lib/order-fulfillment'
import { isPaymentCollected, isPaymentFailed, type GcPayment } from '@/modules/gocardless-instant-bank-pay-for-shop/lib/gocardless'
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
    await markOrderPaymentFailed(row.orderId)
  }
}
