import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'

export type GcpPayment = {
  id: string
  orderId: string
  orderNumber: string
  billingRequestId: string | null
  billingRequestFlowId: string | null
  paymentId: string | null
  status: string
  amount: string
  currency: string
}

function mapRow(r: Record<string, unknown>): GcpPayment {
  return {
    id: r.id as string,
    orderId: r.order_id as string,
    orderNumber: r.order_number as string,
    billingRequestId: (r.billing_request_id as string | null) ?? null,
    billingRequestFlowId: (r.billing_request_flow_id as string | null) ?? null,
    paymentId: (r.payment_id as string | null) ?? null,
    status: r.status as string,
    amount: (r.amount as { toString(): string }).toString(),
    currency: r.currency as string,
  }
}

export async function createGcpPayment(input: {
  orderId: string
  orderNumber: string
  billingRequestId: string
  billingRequestFlowId: string
  amount: number
  currency: string
  status?: string
}): Promise<GcpPayment> {
  const id = randomUUID()
  await prisma.$executeRaw`
    INSERT INTO "gcp_payments" (
      "id", "order_id", "order_number", "billing_request_id", "billing_request_flow_id",
      "status", "amount", "currency", "created_at", "updated_at"
    ) VALUES (
      ${id}, ${input.orderId}, ${input.orderNumber}, ${input.billingRequestId}, ${input.billingRequestFlowId},
      ${input.status ?? 'PENDING'}, ${input.amount}, ${input.currency}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
  `
  const row = await getGcpPaymentById(id)
  if (!row) throw new Error('Failed to create gcp_payments row')
  return row
}

export async function getGcpPaymentById(id: string): Promise<GcpPayment | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "gcp_payments" WHERE "id" = ${id} LIMIT 1
  `
  return rows[0] ? mapRow(rows[0]) : null
}

export async function getGcpPaymentByOrderId(orderId: string): Promise<GcpPayment | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "gcp_payments" WHERE "order_id" = ${orderId} ORDER BY "created_at" DESC LIMIT 1
  `
  return rows[0] ? mapRow(rows[0]) : null
}

export async function getGcpPaymentByBillingRequestId(billingRequestId: string): Promise<GcpPayment | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "gcp_payments" WHERE "billing_request_id" = ${billingRequestId} LIMIT 1
  `
  return rows[0] ? mapRow(rows[0]) : null
}

export async function getGcpPaymentByPaymentId(paymentId: string): Promise<GcpPayment | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "gcp_payments" WHERE "payment_id" = ${paymentId} LIMIT 1
  `
  return rows[0] ? mapRow(rows[0]) : null
}

export async function updateGcpPayment(id: string, patch: { paymentId?: string; status?: string }): Promise<void> {
  if (patch.paymentId !== undefined) {
    await prisma.$executeRaw`UPDATE "gcp_payments" SET "payment_id" = ${patch.paymentId}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = ${id}`
  }
  if (patch.status !== undefined) {
    await prisma.$executeRaw`UPDATE "gcp_payments" SET "status" = ${patch.status}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = ${id}`
  }
}
