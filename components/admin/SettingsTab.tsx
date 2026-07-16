'use client'

// "Instant Bank Pay" panel. The manifest settingsTabs entry sets host
// "shop.payments", so this renders inside admin > Shop > Payments alongside
// Stripe and PayPal rather than as a top-level Settings tab. Credentials are
// stored as environment variables through the core-managed /api/admin/env route
// (declared via requiredEnvVars); the on/off toggle and payment description are
// this module's own settings.
import { useEffect, useState } from 'react'

const ENV_KEYS = [
  { key: 'GOCARDLESS_ACCESS_TOKEN', label: 'Access token', placeholder: 'sandbox_… / live_…', secret: true },
  { key: 'GOCARDLESS_WEBHOOK_SECRET', label: 'Webhook secret', placeholder: '••••••••', secret: true },
] as const

type Status =
  | { configured: false; environment: string }
  | { configured: true; connected: true; environment: string }
  | { configured: true; connected: false; environment: string; error?: string }

type Settings = { enabled: boolean; paymentDescription: string }

export function GoCardlessSettingsTab() {
  const [setVars, setSetVars] = useState<Record<string, boolean>>({})
  const [values, setValues] = useState<Record<string, string>>({})
  const [environment, setEnvironment] = useState<'sandbox' | 'live'>('sandbox')
  const [localMode, setLocalMode] = useState(false)
  const [status, setStatus] = useState<Status | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)

  const [savingConn, setSavingConn] = useState(false)
  const [savedConn, setSavedConn] = useState(false)
  const [connError, setConnError] = useState('')

  const [savingSettings, setSavingSettings] = useState(false)
  const [savedSettings, setSavedSettings] = useState(false)
  const [settingsError, setSettingsError] = useState('')

  const [webhookUrl, setWebhookUrl] = useState('')

  async function load() {
    try {
      const [envRes, statusRes, settingsRes] = await Promise.all([
        fetch('/api/admin/env'),
        fetch('/api/m/gocardless-instant-bank-pay-for-shop/admin/status'),
        fetch('/api/m/gocardless-instant-bank-pay-for-shop/admin/settings'),
      ])
      if (envRes.ok) {
        const d = await envRes.json()
        setSetVars(d.vars ?? {})
        setLocalMode(!!d.localMode)
      }
      if (statusRes.ok) {
        const s = (await statusRes.json()) as Status
        setStatus(s)
        if (s.environment === 'live' || s.environment === 'sandbox') setEnvironment(s.environment)
      }
      if (settingsRes.ok) setSettings(await settingsRes.json())
    } catch {
      // Sections still render with defaults.
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- window.location is only available post-mount; setting it in render would cause a hydration mismatch
    setWebhookUrl(`${window.location.origin}/api/m/gocardless-instant-bank-pay-for-shop/webhook`)
    load()
  }, [])

  async function saveConnection() {
    setSavingConn(true)
    setSavedConn(false)
    setConnError('')
    try {
      const vars: Array<{ key: string; value: string }> = ENV_KEYS
        .map(({ key }) => ({ key, value: values[key] ?? '' }))
        .filter((v) => v.value.trim() !== '')
      // Environment is not secret, so always send it (a select can't be "left blank").
      vars.push({ key: 'GOCARDLESS_ENVIRONMENT', value: environment })

      const res = await fetch('/api/admin/env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vars }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? 'Failed to save')
      setSavedConn(true)
      setValues({})
      await load()
    } catch (err) {
      setConnError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSavingConn(false)
    }
  }

  async function saveSettings(next: Settings) {
    setSavingSettings(true)
    setSavedSettings(false)
    setSettingsError('')
    try {
      const res = await fetch('/api/m/gocardless-instant-bank-pay-for-shop/admin/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? 'Failed to save')
      setSettings(d)
      setSavedSettings(true)
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSavingSettings(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <div className="card">
        <h2 className="card-title">Instant Bank Pay</h2>
        <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)', margin: '0 0 var(--space-4)' }}>
          Let shoppers pay straight from their bank account with GoCardless, no card needed. Add
          your GoCardless access token and webhook secret, choose the environment, then turn the
          method on below. Sandbox and live use different tokens, so switching environment means
          updating the token to match. Grab both from the{' '}
          <a
            href={
              environment === 'live'
                ? 'https://manage.gocardless.com/developers'
                : 'https://manage-sandbox.gocardless.com/developers'
            }
            target="_blank"
            rel="noreferrer"
          >
            GoCardless developer dashboard
          </a>
          .
        </p>

        {connError && <div className="alert alert-danger">{connError}</div>}
        {savedConn && <div className="alert alert-success">Saved. Changes take effect after the next deployment.</div>}

        {status && (
          status.configured === false ? (
            <div className="alert alert-warning">Not connected yet - add the access token and webhook secret below.</div>
          ) : status.connected ? (
            <div className="alert alert-success">
              Connected to GoCardless (<strong>{status.environment}</strong>).
            </div>
          ) : (
            <div className="alert alert-danger">
              Credentials are set but GoCardless rejected them{status.error ? `: ${status.error}` : ''}.
            </div>
          )
        )}

        {localMode ? (
          <div className="alert alert-warning">
            Local development mode: set <code>GOCARDLESS_ACCESS_TOKEN</code>,{' '}
            <code>GOCARDLESS_WEBHOOK_SECRET</code> and <code>GOCARDLESS_ENVIRONMENT</code> in{' '}
            <code>.env.local</code> and restart the dev server.
          </div>
        ) : (
          <>
            <div className="field">
              <label htmlFor="gcp-environment">Environment</label>
              <select
                id="gcp-environment"
                value={environment}
                onChange={(e) => setEnvironment(e.target.value === 'live' ? 'live' : 'sandbox')}
              >
                <option value="sandbox">Sandbox (testing)</option>
                <option value="live">Live</option>
              </select>
            </div>

            {ENV_KEYS.map(({ key, label, placeholder, secret }) => (
              <div className="field" key={key}>
                <label htmlFor={`gcp-${key}`}>
                  {label}
                  {setVars[key] && (
                    <span style={{ marginLeft: 'var(--space-2)', fontSize: 'var(--text-xs)', color: 'var(--color-success, var(--color-text-muted))' }}>
                      (set)
                    </span>
                  )}
                </label>
                <input
                  id={`gcp-${key}`}
                  type={secret ? 'password' : 'text'}
                  value={values[key] ?? ''}
                  placeholder={setVars[key] ? 'Leave blank to keep current value' : placeholder}
                  onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                  autoComplete="off"
                />
              </div>
            ))}

            <button className="btn btn-primary" disabled={savingConn} onClick={saveConnection}>
              {savingConn ? 'Saving…' : 'Save connection'}
            </button>
          </>
        )}

        <div className="field" style={{ marginTop: 'var(--space-4)' }}>
          <label htmlFor="gcp-webhook-url">Webhook URL</label>
          <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)', margin: '0 0 var(--space-2)' }}>
            Add this as a webhook endpoint in your GoCardless dashboard so payments are confirmed
            automatically.
          </p>
          <input id="gcp-webhook-url" type="text" value={webhookUrl} readOnly onFocus={(e) => e.target.select()} />
        </div>
      </div>

      <div className="card">
        <h2 className="card-title">Payment method</h2>
        <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)', margin: '0 0 var(--space-4)' }}>
          When switched on, Instant Bank Pay appears as a payment option at checkout (as long as the
          connection above is working).
        </p>

        {settingsError && <div className="alert alert-danger">{settingsError}</div>}
        {savedSettings && <div className="alert alert-success">Saved.</div>}

        {settings && (
          <>
            <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', margin: '0 0 var(--space-4)', color: 'var(--color-text)' }}>
              <input
                type="checkbox"
                checked={settings.enabled}
                disabled={savingSettings}
                onChange={(e) => saveSettings({ ...settings, enabled: e.target.checked })}
              />
              Offer Instant Bank Pay at checkout
            </label>

            <div className="field">
              <label htmlFor="gcp-description">Payment description</label>
              <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)', margin: '0 0 var(--space-2)' }}>
                Shown to the shopper when they authorise the payment. The order number is added
                automatically. Leave blank to just use the order number.
              </p>
              <input
                id="gcp-description"
                type="text"
                maxLength={100}
                value={settings.paymentDescription}
                placeholder="e.g. Your shop name"
                onChange={(e) => setSettings({ ...settings, paymentDescription: e.target.value })}
                onBlur={() => saveSettings(settings)}
              />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
