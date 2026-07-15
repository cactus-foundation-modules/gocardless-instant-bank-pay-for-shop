-- GoCardless Instant Bank Pay for Shop - initial schema (prefix gcp_).
-- All DDL idempotent so it is safe to re-run on every deploy.

-- Non-secret module settings (singleton). Credentials live in env vars
-- (GOCARDLESS_ACCESS_TOKEN / GOCARDLESS_WEBHOOK_SECRET / GOCARDLESS_ENVIRONMENT),
-- never in the database.
CREATE TABLE IF NOT EXISTS "gcp_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "payment_description" TEXT NOT NULL DEFAULT '',
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gcp_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "gcp_settings_singleton" CHECK ("id" = 'singleton')
);
INSERT INTO "gcp_settings" ("id") VALUES ('singleton') ON CONFLICT ("id") DO NOTHING;

-- One row per checkout attempt: maps a shop order to its GoCardless billing
-- request and (once the shopper authorises) the resulting payment.
CREATE TABLE IF NOT EXISTS "gcp_payments" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "order_number" TEXT NOT NULL,
    "billing_request_id" TEXT,
    "billing_request_flow_id" TEXT,
    "payment_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "amount" NUMERIC(12, 2) NOT NULL,
    "currency" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gcp_payments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "gcp_payments_order_id_idx" ON "gcp_payments" ("order_id");
CREATE UNIQUE INDEX IF NOT EXISTS "gcp_payments_billing_request_id_key" ON "gcp_payments" ("billing_request_id");
CREATE INDEX IF NOT EXISTS "gcp_payments_payment_id_idx" ON "gcp_payments" ("payment_id");
