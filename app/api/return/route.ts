// GET /api/m/gocardless-instant-bank-pay-for-shop/return
// The redirect_uri GoCardless sends the shopper back to after they authorise in
// their bank. Confirms server-side where possible, then hands off to the shop
// confirmation page. The webhook remains the source of truth for settlement.
import { NextRequest, NextResponse } from 'next/server'
import { getSiteUrl } from '@/lib/config/env'
import { getOrderById, markOrderAwaitingConfirmation } from '@/modules/shop/lib/db/orders'
import * as gc from '@/modules/gocardless-instant-bank-pay-for-shop/lib/gocardless'
import { getGcpPaymentByOrderId } from '@/modules/gocardless-instant-bank-pay-for-shop/lib/db'
import { settleFromPayment } from '@/modules/gocardless-instant-bank-pay-for-shop/lib/settle'

export async function GET(request: NextRequest) {
  const siteUrl = getSiteUrl()
  const checkoutUrl = `${siteUrl}/shop/checkout`

  const orderId = request.nextUrl.searchParams.get('order')
  if (!orderId) return NextResponse.redirect(checkoutUrl)

  const order = await getOrderById(orderId)
  const row = await getGcpPaymentByOrderId(orderId)
  if (!order || !row?.billingRequestId) return NextResponse.redirect(checkoutUrl)

  try {
    const billingRequest = await gc.getBillingRequest(row.billingRequestId)
    if (billingRequest.paymentId) {
      const payment = await gc.getPayment(billingRequest.paymentId)
      await settleFromPayment(row, payment)
      // Authorised but not yet settled: show the shopper the "awaiting" state
      // (don't downgrade an order the webhook already marked PAID).
      if (!gc.isPaymentCollected(payment.status) && !gc.isPaymentFailed(payment.status)) {
        const fresh = await getOrderById(orderId)
        if (fresh && fresh.paymentStatus !== 'PAID') await markOrderAwaitingConfirmation(orderId)
      }
    } else {
      const fresh = await getOrderById(orderId)
      if (fresh && fresh.paymentStatus !== 'PAID') await markOrderAwaitingConfirmation(orderId)
    }
  } catch (err) {
    // If GoCardless is unreachable on return, leave the order as-is; the webhook
    // will settle it.
    console.error('[gocardless-ibp] return confirmation failed', err)
  }

  const confirmationUrl =
    `${siteUrl}/shop/checkout/confirmation` +
    `?orderNumber=${encodeURIComponent(order.orderNumber)}&email=${encodeURIComponent(order.customerEmail)}`
  return NextResponse.redirect(confirmationUrl)
}
