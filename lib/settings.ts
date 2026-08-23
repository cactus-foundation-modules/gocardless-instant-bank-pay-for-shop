import { prisma } from '@/lib/db/prisma'

export type GoCardlessSettings = {
  enabled: boolean
  paymentDescription: string
  // Whether the shopper picks their bank here rather than on GoCardless's own
  // page. Off unless the owner turns it on, because it needs the custom payment
  // pages upgrade on the GoCardless account and an account without it gets a
  // bank list that silently comes back empty.
  bankSelectionEnabled: boolean
}

const FALLBACK: GoCardlessSettings = { enabled: false, paymentDescription: '', bankSelectionEnabled: false }

export async function getGoCardlessSettings(): Promise<GoCardlessSettings> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "gcp_settings" WHERE "id" = 'singleton' LIMIT 1
  `
  const r = rows[0]
  if (!r) return FALLBACK
  return {
    enabled: r.enabled as boolean,
    paymentDescription: (r.payment_description as string | null) ?? '',
    bankSelectionEnabled: (r.bank_selection_enabled as boolean | null) ?? false,
  }
}

export async function updateGoCardlessSettings(input: Partial<GoCardlessSettings>): Promise<GoCardlessSettings> {
  const current = await getGoCardlessSettings()
  const merged = { ...current, ...input }
  await prisma.$executeRaw`
    INSERT INTO "gcp_settings" ("id", "enabled", "payment_description", "bank_selection_enabled", "updated_at")
    VALUES ('singleton', ${merged.enabled}, ${merged.paymentDescription}, ${merged.bankSelectionEnabled}, CURRENT_TIMESTAMP)
    ON CONFLICT ("id") DO UPDATE SET
      "enabled" = ${merged.enabled},
      "payment_description" = ${merged.paymentDescription},
      "bank_selection_enabled" = ${merged.bankSelectionEnabled},
      "updated_at" = CURRENT_TIMESTAMP
  `
  return getGoCardlessSettings()
}
