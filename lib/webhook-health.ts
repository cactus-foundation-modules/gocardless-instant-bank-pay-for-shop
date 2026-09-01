// The webhook's own health, written down because nothing else can see it.
//
// A payment confirms one of two ways: the shopper lands back on the return route,
// or GoCardless calls the webhook. The second is the one that matters, because
// the money usually settles after the shopper has closed the tab. If the webhook
// is being turned away, every order sits at "awaiting confirmation" for ever with
// the shopper's money already gone - and nothing in the admin says so. The
// connection card checks the access token, which is the half that tends to be
// fine, and the webhook secret is only ever checked for being *present*.
//
// So the outcome of the last delivery is recorded and shown on that card.
import { prisma } from '@/lib/db/prisma'

export type WebhookHealth = {
  /** ISO timestamp of the last delivery we saw, or null if none ever arrived. */
  lastAt: string | null
  /** Whether that delivery was accepted. Null when none has arrived. */
  ok: boolean | null
  /** Why it was rejected, in words an owner can act on. Null when accepted. */
  error: string | null
}

const NONE: WebhookHealth = { lastAt: null, ok: null, error: null }

/**
 * Remember how the last delivery went.
 *
 * Never throws. A note about the webhook's health must not be the reason a
 * settled payment fails to settle, so a database problem here is logged and
 * swallowed rather than allowed to fail the request that was otherwise fine.
 */
export async function recordWebhookOutcome(ok: boolean, error: string | null): Promise<void> {
  try {
    await prisma.$executeRaw`
      INSERT INTO "gcp_settings" ("id", "last_webhook_at", "last_webhook_ok", "last_webhook_error")
      VALUES ('singleton', CURRENT_TIMESTAMP, ${ok}, ${error})
      ON CONFLICT ("id") DO UPDATE SET
        "last_webhook_at" = CURRENT_TIMESTAMP,
        "last_webhook_ok" = ${ok},
        "last_webhook_error" = ${error}
    `
  } catch (err) {
    console.error('[gocardless-ibp] could not record webhook health', err)
  }
}

export async function getWebhookHealth(): Promise<WebhookHealth> {
  try {
    const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT "last_webhook_at", "last_webhook_ok", "last_webhook_error"
      FROM "gcp_settings" WHERE "id" = 'singleton' LIMIT 1
    `
    const r = rows[0]
    if (!r) return NONE
    const at = r.last_webhook_at
    return {
      lastAt: at instanceof Date ? at.toISOString() : null,
      ok: (r.last_webhook_ok as boolean | null) ?? null,
      error: (r.last_webhook_error as string | null) ?? null,
    }
  } catch (err) {
    // An install that has not run migration 004 yet has no columns to read. The
    // settings card is more useful without this line than it is broken by it.
    console.error('[gocardless-ibp] could not read webhook health', err)
    return NONE
  }
}
