import { prisma } from '@/lib/db/prisma'

export type GoCardlessSettings = {
  enabled: boolean
  paymentDescription: string
}

const FALLBACK: GoCardlessSettings = { enabled: false, paymentDescription: '' }

export async function getGoCardlessSettings(): Promise<GoCardlessSettings> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "gcp_settings" WHERE "id" = 'singleton' LIMIT 1
  `
  const r = rows[0]
  if (!r) return FALLBACK
  return {
    enabled: r.enabled as boolean,
    paymentDescription: (r.payment_description as string | null) ?? '',
  }
}

export async function updateGoCardlessSettings(input: Partial<GoCardlessSettings>): Promise<GoCardlessSettings> {
  const current = await getGoCardlessSettings()
  const merged = { ...current, ...input }
  await prisma.$executeRaw`
    INSERT INTO "gcp_settings" ("id", "enabled", "payment_description", "updated_at")
    VALUES ('singleton', ${merged.enabled}, ${merged.paymentDescription}, CURRENT_TIMESTAMP)
    ON CONFLICT ("id") DO UPDATE SET
      "enabled" = ${merged.enabled},
      "payment_description" = ${merged.paymentDescription},
      "updated_at" = CURRENT_TIMESTAMP
  `
  return getGoCardlessSettings()
}
