// GET /api/m/gocardless-instant-bank-pay-for-shop/return
// The redirect_uri GoCardless sends the shopper back to after they authorise in
// their bank. Confirms server-side where possible, then hands off to the shop
// confirmation page. The webhook remains the source of truth for settlement.
//
// This method does not create its order until the money is committed (see the
// shop's lib/checkout-draft), so there may be no order here at all - and where
// the shopper backed out on the bank's own page, there should not be. That case
// goes back to the checkout with the basket still in it, rather than to a
// confirmation page for something nobody paid for.
import { NextRequest, NextResponse } from 'next/server'
import { getSiteUrl } from '@/lib/config/env'
import { signOrderReceiptToken } from '@/modules/shop/lib/order-receipt-token'
import { getOrderById } from '@/modules/shop/lib/db/orders'
import * as gc from '@/modules/gocardless-instant-bank-pay-for-shop/lib/gocardless'
import { getGcpPaymentByOrderId } from '@/modules/gocardless-instant-bank-pay-for-shop/lib/db'
import { settleFromAuthorisedRequest, settleFromPayment } from '@/modules/gocardless-instant-bank-pay-for-shop/lib/settle'

export async function GET(request: NextRequest) {
  const siteUrl = getSiteUrl()
  const checkoutUrl = `${siteUrl}/shop/checkout`

  const orderId = request.nextUrl.searchParams.get('order')
  if (!orderId) return NextResponse.redirect(checkoutUrl)

  const row = await getGcpPaymentByOrderId(orderId)
  if (!row?.billingRequestId) return NextResponse.redirect(checkoutUrl)

  try {
    const billingRequest = await gc.getBillingRequest(row.billingRequestId)
    if (billingRequest.paymentId) {
      // settleFromPayment does the rest: it checks the money is this order's,
      // creates the order if it has not been created yet, and marks it PAID or
      // awaiting depending on whether the payment has been collected.
      await settleFromPayment(row, await gc.getPayment(billingRequest.paymentId))
    } else if (gc.isBillingRequestAuthorised(billingRequest.status)) {
      // Authorised at the bank, payment resource still to come. The money is
      // committed, so the order exists from here even though there is nothing to
      // settle it against yet.
      await settleFromAuthorisedRequest(orderId)
    }
    // Anything else - a request still sitting at `pending` - means the shopper
    // never authorised. Nothing is created and they go back to the checkout.
  } catch (err) {
    // If GoCardless is unreachable on return, leave things as they are; the
    // webhook will settle it.
    console.error('[gocardless-ibp] return confirmation failed', err)
  }

  // Read after settling, never before: on this method the order is very often
  // brought into being by the lines above.
  const order = await getOrderById(orderId)
  if (!order) return NextResponse.redirect(checkoutUrl)

  // The signed receipt token, never the customer's email address. A redirect
  // URL lands in the site's access logs, the shopper's browser history and the
  // Referer header sent to every third party the confirmation page loads - and
  // an email address has no business in any of them. See shop's
  // lib/order-receipt-token, which the confirmation page verifies against.
  const confirmationUrl =
    `${siteUrl}/shop/checkout/confirmation` +
    `?orderNumber=${encodeURIComponent(order.orderNumber)}&t=${encodeURIComponent(signOrderReceiptToken(order.orderNumber))}`
  return NextResponse.redirect(confirmationUrl)
}
