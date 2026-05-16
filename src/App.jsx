import { useEffect, useState } from 'react'
import { supabase } from './supabase'

const DRILL_PROGRESS_KEY = 'bunpouWeb.drillProgress.v1'

function buildAssetUrl(path) {
  return `${import.meta.env.BASE_URL}${path}`
}

function readDrillProgress() {
  try {
    const raw = localStorage.getItem(DRILL_PROGRESS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

function writeDrillProgress(progressByUid) {
  localStorage.setItem(DRILL_PROGRESS_KEY, JSON.stringify(progressByUid))
}

export default function App() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const [manifest, setManifest] = useState(null)
  const [manifestLoading, setManifestLoading] = useState(false)
  const [manifestError, setManifestError] = useState('')

  const [selectedDrill, setSelectedDrill] = useState(null)
  const [drillLoading, setDrillLoading] = useState(false)
  const [drillError, setDrillError] = useState('')

  const [answers, setAnswers] = useState({})
  const [submitMessage, setSubmitMessage] = useState('')
  const [completedDrills, setCompletedDrills] = useState({})

  useEffect(() => {
    let mounted = true

    supabase.auth.getUser().then(({ data, error: getUserError }) => {
      if (!mounted) return
      if (getUserError) {
        const isMissingSessionError = getUserError.name === 'AuthSessionMissingError' || getUserError.message === 'Auth session missing!'

        if (!isMissingSessionError) {
          setError(getUserError.message)
        }
        setUser(null)
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

  useEffect(() => {
    if (!user) {
      setManifest(null)
      setManifestError('')
      setSelectedDrill(null)
      setDrillError('')
      setAnswers({})
      setSubmitMessage('')
      setCompletedDrills({})
      return
    }

    const localProgress = readDrillProgress()
    const completed = Object.fromEntries(
      Object.entries(localProgress).filter(([, progress]) => Boolean(progress?.completed))
    )
    setCompletedDrills(completed)

    let active = true
    setManifestLoading(true)
    setManifestError('')

    fetch(buildAssetUrl('drills/manifest.json'))
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Could not load drill manifest (${response.status}).`)
        }
        return response.json()
      })
      .then((manifestData) => {
        if (!active) return
        setManifest(manifestData)
      })
      .catch((manifestFetchError) => {
        if (!active) return
        setManifestError(manifestFetchError.message)
      })
      .finally(() => {
        if (!active) return
        setManifestLoading(false)
      })

    return () => {
      active = false
    }
  }, [user])

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

  async function openDrill(path) {
    setDrillLoading(true)
    setDrillError('')
    setSubmitMessage('')
    setAnswers({})

    try {
      const response = await fetch(buildAssetUrl(path))
      if (!response.ok) {
        throw new Error(`Could not load drill (${response.status}).`)
      }
      const drillData = await response.json()
      const progressByUid = readDrillProgress()
      const existingProgress = progressByUid[drillData.drill_uid]

      setSelectedDrill(drillData)
      setAnswers(existingProgress?.answers ?? {})
      if (existingProgress?.completed) {
        setSubmitMessage('Answers captured. Grading comes in the next milestone.')
      }
    } catch (openDrillError) {
      setDrillError(openDrillError.message)
    } finally {
      setDrillLoading(false)
    }
  }

  function persistAnswers(nextAnswers) {
    if (!selectedDrill?.drill_uid) return
    const progressByUid = readDrillProgress()
    const currentProgress = progressByUid[selectedDrill.drill_uid] ?? {}
    progressByUid[selectedDrill.drill_uid] = {
      ...currentProgress,
      answers: nextAnswers,
      completed: Boolean(currentProgress.completed),
    }
    writeDrillProgress(progressByUid)
  }

  function handleChoiceChange(questionId, choiceId) {
    setAnswers((previous) => {
      const nextAnswers = { ...previous, [questionId]: choiceId }
      persistAnswers(nextAnswers)
      return nextAnswers
    })
  }

  function handleTextChange(questionId, value) {
    setAnswers((previous) => {
      const nextAnswers = { ...previous, [questionId]: value }
      persistAnswers(nextAnswers)
      return nextAnswers
    })
  }

  function clearAnswers() {
    if (!selectedDrill?.drill_uid) return
    setAnswers({})
    setSubmitMessage('')
    const progressByUid = readDrillProgress()
    const currentProgress = progressByUid[selectedDrill.drill_uid] ?? {}
    progressByUid[selectedDrill.drill_uid] = {
      ...currentProgress,
      answers: {},
      completed: false,
    }
    writeDrillProgress(progressByUid)
    setCompletedDrills((previous) => {
      const next = { ...previous }
      delete next[selectedDrill.drill_uid]
      return next
    })
  }

  function submitDrill(event) {
    event.preventDefault()
    if (!selectedDrill?.drill_uid) return

    const progressByUid = readDrillProgress()
    progressByUid[selectedDrill.drill_uid] = {
      answers,
      completed: true,
      completedAt: new Date().toISOString(),
    }
    writeDrillProgress(progressByUid)

    setCompletedDrills((previous) => ({
      ...previous,
      [selectedDrill.drill_uid]: progressByUid[selectedDrill.drill_uid],
    }))
    setSubmitMessage('Answers captured. Grading comes in the next milestone.')
  }

  const isSelectedDrillCompleted = Boolean(selectedDrill?.drill_uid && completedDrills[selectedDrill.drill_uid])

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
            {manifestLoading ? <p className="status">Loading drills...</p> : null}
            {manifestError ? <p className="error" role="alert">{manifestError}</p> : null}

            {!manifestLoading && !manifestError && manifest && !selectedDrill ? (
              <div className="drill-list" aria-live="polite">
                <h2>Available drills</h2>
                {manifest.drills?.length ? (
                  manifest.drills.map((drill) => {
                    const isCompleted = Boolean(completedDrills[drill.drill_uid])
                    return (
                      <article key={drill.drill_uid} className="drill-card">
                        <h3>{drill.title}</h3>
                        <p>{drill.description}</p>
                        <p className="meta">Questions: {drill.question_count}</p>
                        {isCompleted ? <p className="status-badge" aria-label="Completed">Completed</p> : null}
                        <button type="button" onClick={() => openDrill(drill.path)} disabled={drillLoading}>
                          {isCompleted ? 'Review drill' : 'Open drill'}
                        </button>
                      </article>
                    )
                  })
                ) : (
                  <p className="status">No drills found.</p>
                )}
              </div>
            ) : null}

            {drillLoading ? <p className="status">Loading drill...</p> : null}
            {drillError ? <p className="error" role="alert">{drillError}</p> : null}

            {selectedDrill ? (
              <form className="drill-form" onSubmit={submitDrill}>
                <h2>{selectedDrill.title}</h2>
                <p>{selectedDrill.description}</p>
                <p className="meta">Question count: {selectedDrill.question_count}</p>
                {isSelectedDrillCompleted ? <p className="status-badge">Completed (read only)</p> : null}

                {selectedDrill.questions.map((question, index) => (
                  <fieldset key={question.question_id} className="question-block" disabled={isSelectedDrillCompleted}>
                    <p className="question-label">Question {index + 1}</p>
                    <p className="question-prompt">{question.prompt}</p>

                    {question.type === 'multiple_choice' ? (
                      <div className="choices">
                        {question.choices.map((choice) => {
                          const isChecked = answers[question.question_id] === choice.choice_id
                          return (
                            <label
                              key={choice.choice_id}
                              className={`choice-row ${isChecked ? 'choice-row-selected' : ''}`}
                            >
                              <input
                                type="radio"
                                name={question.question_id}
                                value={choice.choice_id}
                                checked={isChecked}
                                onChange={() => handleChoiceChange(question.question_id, choice.choice_id)}
                                disabled={isSelectedDrillCompleted}
                              />
                              <span>{choice.choice_id}. {choice.text}</span>
                            </label>
                          )
                        })}
                      </div>
                    ) : (
                      <input
                        type="text"
                        value={answers[question.question_id] ?? ''}
                        onChange={(event) => handleTextChange(question.question_id, event.target.value)}
                        placeholder="Type your answer"
                        disabled={isSelectedDrillCompleted}
                      />
                    )}
                  </fieldset>
                ))}

                <div className="button-row">
                  <button type="button" onClick={() => setSelectedDrill(null)}>Back to drill list</button>
                  <button type="button" onClick={clearAnswers} disabled={isSelectedDrillCompleted}>Clear answers</button>
                  <button type="submit" disabled={isSelectedDrillCompleted}>Submit</button>
                </div>

                {submitMessage ? <p className="status success">{submitMessage}</p> : null}

                <details>
                  <summary>Debug: captured answers</summary>
                  <pre>{JSON.stringify(answers, null, 2)}</pre>
                </details>
              </form>
            ) : null}

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
