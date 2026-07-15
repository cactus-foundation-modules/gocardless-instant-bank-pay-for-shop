// GET /api/m/gocardless-instant-bank-pay-for-shop/admin/status
// Reports whether the credentials are set and whether GoCardless accepts them.
import { NextResponse } from 'next/server'
import { requireShopUser } from '@/modules/shop/lib/access'
import { isGoCardlessConfigured, getGoCardlessEnvironment } from '@/modules/gocardless-instant-bank-pay-for-shop/lib/env'
import { verifyCredentials } from '@/modules/gocardless-instant-bank-pay-for-shop/lib/gocardless'

export async function GET() {
  const gate = await requireShopUser('shop.manage')
  if (gate.error) return gate.error

  if (!isGoCardlessConfigured()) {
    return NextResponse.json({ configured: false, environment: getGoCardlessEnvironment() })
  }

  try {
    await verifyCredentials()
    return NextResponse.json({ configured: true, connected: true, environment: getGoCardlessEnvironment() })
  } catch (err) {
    return NextResponse.json({
      configured: true,
      connected: false,
      environment: getGoCardlessEnvironment(),
      error: err instanceof Error ? err.message : 'Connection failed',
    })
  }
}
