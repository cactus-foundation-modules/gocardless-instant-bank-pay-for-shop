-- What happened to the last webhook GoCardless sent us.
--
-- Worth a column each because nothing else in the system can see it. GoCardless
-- verifies nothing when an endpoint is added: an endpoint whose secret does not
-- match ours is accepted by their dashboard, delivers happily, and is turned
-- away here - and the only record of that lives in GoCardless's own log, which
-- nobody reads until an order has sat unconfirmed for days. Meanwhile the
-- settings card cheerfully says "Connected to GoCardless", because that check
-- only ever exercised the access token, which is the half that was fine.
--
-- Idempotent, like every migration in this module.
ALTER TABLE "gcp_settings" ADD COLUMN IF NOT EXISTS "last_webhook_at" TIMESTAMP(3);
ALTER TABLE "gcp_settings" ADD COLUMN IF NOT EXISTS "last_webhook_ok" BOOLEAN;
ALTER TABLE "gcp_settings" ADD COLUMN IF NOT EXISTS "last_webhook_error" TEXT;
