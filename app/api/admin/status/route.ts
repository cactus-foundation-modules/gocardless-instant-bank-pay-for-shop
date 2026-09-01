// GET /api/m/gocardless-instant-bank-pay-for-shop/admin/status
// Reports whether the credentials are set and whether GoCardless accepts them.
import { NextResponse } from 'next/server'
import { requireShopUser } from '@/modules/shop/lib/access'
import { isGoCardlessConfigured, getGoCardlessEnvironment } from '@/modules/gocardless-instant-bank-pay-for-shop/lib/env'
import { checkBankSelectionSupport, verifyCredentials } from '@/modules/gocardless-instant-bank-pay-for-shop/lib/gocardless'
import { getWebhookHealth } from '@/modules/gocardless-instant-bank-pay-for-shop/lib/webhook-health'

export async function GET() {
  const gate = await requireShopUser('shop.manage')
  if (gate.error) return gate.error

  // Reported whether or not the credentials check out, because the two are
  // independent: the access token can be perfect while the webhook secret is
  // wrong, and that combination is the one that quietly strands orders.
  const webhook = await getWebhookHealth()

  if (!isGoCardlessConfigured()) {
    return NextResponse.json({ configured: false, environment: getGoCardlessEnvironment(), webhook })
  }

  try {
    await verifyCredentials()
    // Asked alongside the credential check rather than on its own, because the
    // two answers are read together: an owner looking at this card wants to know
    // both that GoCardless is talking to them and what it will let them do.
    const bankSelection = await checkBankSelectionSupport()
    return NextResponse.json({ configured: true, connected: true, environment: getGoCardlessEnvironment(), bankSelection, webhook })
  } catch (err) {
    return NextResponse.json({
      configured: true,
      connected: false,
      environment: getGoCardlessEnvironment(),
      error: err instanceof Error ? err.message : 'Connection failed',
      webhook,
    })
  }
}
