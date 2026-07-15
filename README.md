# GoCardless Instant Bank Pay for Shop

Adds **Instant Bank Pay** as a checkout payment method in the Cactus Shop:
a one-off, open-banking (pay-by-bank) payment where the shopper authorises the
payment directly in their own banking app. No card, no stored mandate.

Built on GoCardless's [Billing Requests API](https://developer.gocardless.com/billing-requests/overview).

- **Table prefix:** `gcp_`
- **Depends on:** the `shop` module (`>= 0.1.27`, which exposes the
  `shop.payment-providers` extension point)

## How it works

1. At checkout the shopper picks *Instant Bank Pay*. The module creates a
   GoCardless billing request and a billing request flow, then redirects the
   shopper to their bank to authorise.
2. On return, and via GoCardless webhooks, the order is confirmed: it stays at
   *Awaiting confirmation* until the payment settles, then flips to *Paid* and
   the usual order fulfilment (email, stock, downloads) runs.
3. Refunds are issued from the order screen like any other provider.

## Configuration

Set these environment variables (managed on **Settings → Instant Bank Pay** in
the admin, or in `.env.local` for local development):

| Variable | Purpose |
|----------|---------|
| `GOCARDLESS_ACCESS_TOKEN` | Your GoCardless API access token. |
| `GOCARDLESS_WEBHOOK_SECRET` | The secret for the webhook endpoint you add in the GoCardless dashboard. |
| `GOCARDLESS_ENVIRONMENT` | `sandbox` (default) or `live`. |

Then turn the method on under **Settings → Instant Bank Pay** and add a webhook
in the GoCardless dashboard pointing at:

```
https://<your-site>/api/m/gocardless-instant-bank-pay-for-shop/webhook
```

Sandbox and live use different access tokens, so switching `GOCARDLESS_ENVIRONMENT`
means updating the token to match.
