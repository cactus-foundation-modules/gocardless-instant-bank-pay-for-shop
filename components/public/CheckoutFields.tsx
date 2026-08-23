'use client'

// The bank picker, drawn on the shop's own checkout under the Instant Bank Pay
// radio button. Registered on the shop's 'shop.checkout-payment-fields'
// extension point (see the manifest).
//
// It answers the two questions the GoCardless hosted page would otherwise ask
// before it could do anything - which bank, and who is paying - so that placing
// the order goes straight to the shopper's own bank instead of to two GoCardless
// screens first. The bank authorisation itself still happens at GoCardless and
// then at the bank, because GoCardless only permit it from their own page; see
// lib/gocardless.ts for the regulatory reason.
//
// Nothing here is required. A shopper who ignores it, or a list that will not
// load, simply gets the bank picker on the next screen as before - so this can
// only ever save a step, never cost one.
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ShopCheckoutPaymentFieldsProps } from '@/modules/shop/components/public/checkout-payment-fields'

type Institution = {
  id: string
  name: string
  iconUrl: string | null
  logoUrl: string | null
  countryCode: string | null
}

const MODULE_API = '/api/m/gocardless-instant-bank-pay-for-shop/public'

// Above this many banks the list needs a search box to be usable; below it, a
// search box is a chore in front of a list you can already read.
const SEARCH_THRESHOLD = 8

export function GoCardlessCheckoutFields({ config, payer, onError }: ShopCheckoutPaymentFieldsProps) {
  const orderId = typeof config.orderId === 'string' ? config.orderId : null
  const countryCode = (payer.address.country || 'GB').toUpperCase()

  const [institutions, setInstitutions] = useState<Institution[] | null>(null)
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!orderId) return
    let cancelled = false
    fetch(`${MODULE_API}/institutions?order=${encodeURIComponent(orderId)}&country=${encodeURIComponent(countryCode)}`)
      .then((r) => (r.ok ? r.json() : { institutions: [] }))
      .then((data) => {
        if (cancelled) return
        setInstitutions(Array.isArray(data.institutions) ? data.institutions : [])
      })
      // Silent, and deliberately so: the shopper loses a shortcut, not the
      // ability to pay. The empty list below says as much in plain words.
      .catch(() => { if (!cancelled) setInstitutions([]) })
    return () => { cancelled = true }
  }, [orderId, countryCode])

  const filtered = useMemo(() => {
    const all = institutions ?? []
    const q = query.trim().toLowerCase()
    if (!q) return all
    return all.filter((i) => i.name.toLowerCase().includes(q))
  }, [institutions, query])

  const choose = useCallback(async (institution: Institution) => {
    if (!orderId) return
    const previous = chosen
    setChosen(institution.id)
    setSaving(true)
    onError(null)
    try {
      const res = await fetch(`${MODULE_API}/select-bank`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderId,
          institution: institution.id,
          countryCode,
          payer: {
            email: payer.email,
            name: payer.name,
            addressLine1: payer.address.line1,
            ...(payer.address.line2 ? { addressLine2: payer.address.line2 } : {}),
            city: payer.address.city,
            ...(payer.address.county ? { region: payer.address.county } : {}),
            postalCode: payer.address.postcode,
          },
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        throw new Error(data?.error ?? 'That bank could not be selected.')
      }
    } catch (err) {
      // Put the choice back where it was. Leaving the new bank ticked would tell
      // the shopper it had been recorded when it had not, and they would arrive
      // at the hosted page being asked a question they thought they had answered.
      setChosen(previous)
      onError(err instanceof Error ? err.message : 'That bank could not be selected.')
    } finally {
      setSaving(false)
    }
  }, [chosen, countryCode, onError, orderId, payer])

  if (!orderId) return null

  if (institutions === null) {
    return <p style={{ color: 'var(--color-text-muted)', fontSize: '0.875rem', margin: 0 }}>Loading your bank list…</p>
  }

  if (institutions.length === 0) {
    return (
      <p style={{ color: 'var(--color-text-muted)', fontSize: '0.875rem', margin: 0 }}>
        You will choose your bank on the next screen, then approve the payment in your banking app.
      </p>
    )
  }

  const chosenBank = institutions.find((i) => i.id === chosen) ?? null

  return (
    <div style={{ display: 'grid', gap: '0.5rem' }}>
      <p style={{ margin: 0, fontSize: '0.875rem' }}>Choose your bank</p>
      {institutions.length > SEARCH_THRESHOLD && (
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search banks"
          aria-label="Search banks"
          style={{
            padding: '0.4rem 0.6rem', borderRadius: 6, fontSize: '0.875rem',
            border: '1px solid var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text)',
          }}
        />
      )}
      <div
        role="radiogroup"
        aria-label="Your bank"
        style={{ display: 'grid', gap: '0.25rem', maxHeight: 260, overflowY: 'auto', padding: '0.125rem' }}
      >
        {filtered.map((bank) => (
          <label
            key={bank.id}
            style={{
              display: 'flex', gap: '0.5rem', alignItems: 'center', cursor: 'pointer',
              border: '1px solid var(--color-border)', borderRadius: 6, padding: '0.375rem 0.5rem',
              background: chosen === bank.id ? 'var(--color-info-subtle)' : 'transparent',
            }}
          >
            <input
              type="radio"
              name="gocardlessInstitution"
              checked={chosen === bank.id}
              onChange={() => { void choose(bank) }}
              disabled={saving}
            />
            {bank.iconUrl && (
              // eslint-disable-next-line @next/next/no-img-element -- GoCardless's own CDN mark for the bank, not a local asset for the image optimiser
              <img src={bank.iconUrl} alt="" width={20} height={20} style={{ height: 20, width: 20, flex: '0 0 auto', borderRadius: 4 }} />
            )}
            <span style={{ fontSize: '0.875rem', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{bank.name}</span>
          </label>
        ))}
        {filtered.length === 0 && (
          <p style={{ color: 'var(--color-text-muted)', fontSize: '0.875rem', margin: '0.25rem' }}>No banks match that.</p>
        )}
      </div>
      <p style={{ color: 'var(--color-text-muted)', fontSize: '0.8125rem', margin: 0 }}>
        {chosenBank
          ? `Placing your order takes you to ${chosenBank.name} to approve the payment. No card details are involved.`
          : 'Pick your bank and placing your order takes you straight there to approve the payment. No card details are involved.'}
      </p>
    </div>
  )
}
