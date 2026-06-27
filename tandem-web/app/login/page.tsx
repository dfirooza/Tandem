import { signIn } from '@/app/auth/actions'

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams

  return (
    <main>
      <h1>Sign in to Tandem</h1>
      {error && <p className="error">{error}</p>}
      <form action={signIn}>
        <label>
          Email
          <input type="email" name="email" required autoComplete="email" />
        </label>
        <label style={{ marginTop: '0.75rem', display: 'block' }}>
          Password
          <input type="password" name="password" required autoComplete="current-password" />
        </label>
        <button type="submit">Sign in</button>
      </form>
      <p style={{ marginTop: '1rem' }}>
        No account? <a href="/signup">Sign up</a>
      </p>
    </main>
  )
}
