import { useEffect, useState } from 'react'
import { supabase } from './supabase'

export default function App() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let mounted = true

    supabase.auth.getUser().then(({ data, error: getUserError }) => {
      if (!mounted) return
      if (getUserError) {
        setError(getUserError.message)
      } else {
        setUser(data.user)
      }
      setLoading(false)
    })

    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
    })

    return () => {
      mounted = false
      authListener.subscription.unsubscribe()
    }
  }, [])

  async function handleSubmit(event) {
    event.preventDefault()
    setError('')
    setSubmitting(true)

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    if (signInError) {
      setError(signInError.message)
    } else {
      setPassword('')
    }

    setSubmitting(false)
  }

  async function handleLogout() {
    setError('')
    setSubmitting(true)
    const { error: signOutError } = await supabase.auth.signOut()
    if (signOutError) {
      setError(signOutError.message)
    }
    setSubmitting(false)
  }

  return (
    <main className="page">
      <section className="card" aria-busy={loading || submitting}>
        <h1>Bunpou Web</h1>
        <p className="subtitle">Japanese grammar drills</p>

        {loading ? (
          <p className="status">Loading session...</p>
        ) : user ? (
          <div className="dashboard">
            <p className="status">Signed in as <strong>{user.email}</strong></p>
            <p className="placeholder">Drill dashboard coming next.</p>
            <button type="button" onClick={handleLogout} disabled={submitting}>
              {submitting ? 'Logging out...' : 'Logout'}
            </button>
          </div>
        ) : (
          <form className="form" onSubmit={handleSubmit}>
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              required
            />

            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />

            <button type="submit" disabled={submitting}>
              {submitting ? 'Logging in...' : 'Login'}
            </button>
          </form>
        )}

        {error ? <p className="error" role="alert">{error}</p> : null}
      </section>
    </main>
  )
}
