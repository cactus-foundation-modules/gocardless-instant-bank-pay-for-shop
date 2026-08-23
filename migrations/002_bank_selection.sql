-- Bank selection on the shop's own checkout: off by default, because it needs
-- the "custom payment pages" upgrade enabling on the GoCardless account before
-- it can work, and that is a conversation with GoCardless rather than a switch
-- anybody here can throw. Idempotent, like every migration in this module.
ALTER TABLE "gcp_settings" ADD COLUMN IF NOT EXISTS "bank_selection_enabled" BOOLEAN NOT NULL DEFAULT false;
