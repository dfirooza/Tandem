import { signUp } from '@/app/auth/actions'

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams

  return (
    <main>
      <h1>Create a Tandem account</h1>
      {error && <p className="error">{error}</p>}
      <form action={signUp}>
        <label>
          Email
          <input type="email" name="email" required autoComplete="email" />
        </label>
        <label style={{ marginTop: '0.75rem', display: 'block' }}>
          Password
          <input type="password" name="password" required autoComplete="new-password" minLength={6} />
        </label>
        <button type="submit">Create account</button>
      </form>
      <p style={{ marginTop: '1rem' }}>
        Already have an account? <a href="/login">Sign in</a>
      </p>
    </main>
  )
}
