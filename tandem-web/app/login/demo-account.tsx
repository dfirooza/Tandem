'use client'

import { useEffect, useRef, useState } from 'react'

// Presentational only: shows the shared demo credentials and (optionally)
// drops them into the sign-in form above. Auth still runs entirely through
// the existing server action — this just sets the input values.

const DEMO_EMAIL = 'tandemdemo2026@gmail.com'
const DEMO_PASSWORD = 'WelcomeTandem2026!'

export default function DemoAccount() {
  const [filled, setFilled] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  // The inputs are uncontrolled (no value/onChange), so assigning .value is
  // enough — there is no React state to keep in sync.
  function autofill() {
    const email = document.getElementById('email') as HTMLInputElement | null
    const password = document.getElementById('password') as HTMLInputElement | null
    if (email) email.value = DEMO_EMAIL
    if (password) password.value = DEMO_PASSWORD

    setFilled(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setFilled(false), 1800)
  }

  return (
    <div className="mt-6 rounded-md border border-border bg-surface px-3.5 py-3">
      <p className="eyebrow mb-1.5">Demo account</p>
      <p className="mb-2.5 text-xs text-muted">Try Tandem without signing up.</p>

      <dl className="mb-3 space-y-1 font-mono text-[11.5px]">
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-muted">Email</dt>
          <dd className="select-all break-all text-secondary">{DEMO_EMAIL}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-muted">Password</dt>
          <dd className="select-all break-all text-secondary">{DEMO_PASSWORD}</dd>
        </div>
      </dl>

      <button type="button" onClick={autofill} className="btn-ghost text-xs">
        {filled ? 'Filled in above' : 'Use these credentials'}
      </button>
    </div>
  )
}
