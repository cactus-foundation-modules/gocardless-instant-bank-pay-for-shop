// Credentials and environment for GoCardless, sourced from env vars (managed on
// the core admin settings page, like the Stripe/PayPal keys in shop). Nothing
// secret is stored in the database.

export function getGoCardlessAccessToken(): string | null {
  return process.env.GOCARDLESS_ACCESS_TOKEN || null
}

export function getGoCardlessWebhookSecret(): string | null {
  return process.env.GOCARDLESS_WEBHOOK_SECRET || null
}

// Both the access token (to talk to the API) and the webhook secret (to confirm
// payments settle) are needed for the method to work end to end, so both must be
// present before it is offered at checkout.
export function isGoCardlessConfigured(): boolean {
  return !!(getGoCardlessAccessToken() && getGoCardlessWebhookSecret())
}

export function getGoCardlessEnvironment(): 'live' | 'sandbox' {
  return process.env.GOCARDLESS_ENVIRONMENT === 'live' ? 'live' : 'sandbox'
}

export function getGoCardlessApiBase(): string {
  return getGoCardlessEnvironment() === 'live'
    ? 'https://api.gocardless.com'
    : 'https://api-sandbox.gocardless.com'
}
