import { signUp } from '@/app/auth/actions'

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams

  return (
    <main className="mx-auto mt-24 w-full max-w-sm px-4">
      <p className="mb-6 text-center font-mono text-sm tracking-widest text-muted">
        TANDEM
      </p>
      <div className="card p-6">
        <h1 className="mb-4">Create an account</h1>
        {error && <p className="error">{error}</p>}
        <form action={signUp} className="space-y-4">
          <label>
            Email
            <input className="input" type="email" name="email" required autoComplete="email" />
          </label>
          <label>
            Password
            <input
              className="input"
              type="password"
              name="password"
              required
              autoComplete="new-password"
              minLength={6}
            />
          </label>
          <button type="submit" className="btn-primary w-full justify-center">
            Create account
          </button>
        </form>
      </div>
      <p className="mt-4 text-center text-sm text-muted">
        Already have an account? <a href="/login">Sign in</a>
      </p>
    </main>
  )
}
