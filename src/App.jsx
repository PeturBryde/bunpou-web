import { useEffect, useMemo, useState } from 'react'
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

function normalizeText(value, normalizeJapanesePunctuation) {
  let normalized = String(value ?? '').replaceAll('　', ' ').trim()
  if (normalizeJapanesePunctuation) {
    normalized = normalized
      .replaceAll('，', ',')
      .replaceAll('、', ',')
      .replaceAll('．', '.')
      .replaceAll('。', '.')
      .replaceAll('：', ':')
      .replaceAll('；', ';')
      .replaceAll('！', '!')
      .replaceAll('？', '?')
      .replaceAll('（', '(')
      .replaceAll('）', ')')
  }
  return normalized
}

function gradeDrill(drill, answers) {
  const maxScore = (drill.questions ?? []).reduce((total, question) => total + (question.points ?? 2), 0)
  const perQuestion = (drill.questions ?? []).map((question) => {
    const points = question.points ?? 2
    const rawAnswer = answers[question.question_id]

    if (question.type === 'multiple_choice') {
      const correctChoiceId = question.answer?.correct_choice_id
      const isCorrect = rawAnswer === correctChoiceId
      return {
        question_id: question.question_id,
        type: question.type,
        user_answer: rawAnswer ?? null,
        score: isCorrect ? points : 0,
        max_score: points,
        is_correct: isCorrect,
        is_preliminary: false,
        website_result: isCorrect ? 'correct' : 'incorrect',
      }
    }

    const acceptedAnswers = Array.isArray(question.answer?.accepted_answers) ? question.answer.accepted_answers : []
    const normalizePunctuation = Boolean(question.answer?.normalize_japanese_punctuation)
    const normalizedUserAnswer = normalizeText(rawAnswer ?? '', normalizePunctuation)
    const normalizedAccepted = acceptedAnswers.map((answer) => normalizeText(answer, normalizePunctuation))
    const isCorrect = normalizedAccepted.includes(normalizedUserAnswer)

    return {
      question_id: question.question_id,
      type: question.type,
      user_answer: rawAnswer ?? '',
      normalized_user_answer: normalizedUserAnswer,
      accepted_answers: acceptedAnswers,
      score: isCorrect ? points : 0,
      max_score: points,
      is_correct: isCorrect,
      is_preliminary: true,
      website_result: isCorrect ? 'correct' : 'needs_review',
    }
  })

  const totalScore = perQuestion.reduce((sum, result) => sum + result.score, 0)

  return {
    attempt_id: `attempt_${crypto.randomUUID()}`,
    drill_uid: drill.drill_uid,
    drill_version: drill.version,
    completed_at: new Date().toISOString(),
    answers,
    results: perQuestion,
    summary: {
      website_score: totalScore,
      max_score: maxScore,
      question_count: drill.questions?.length ?? 0,
      preliminary_question_count: perQuestion.filter((item) => item.is_preliminary).length,
    },
    completed: true,
  }
}


function hasGradedSummary(progress) {
  return Boolean(
    progress?.summary
      && typeof progress.summary.website_score === 'number'
      && typeof progress.summary.max_score === 'number'
      && Array.isArray(progress.results)
  )
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
  const [attemptResult, setAttemptResult] = useState(null)
  const [legacyCompletedWithoutGrading, setLegacyCompletedWithoutGrading] = useState(false)

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
      setAttemptResult(null)
      setLegacyCompletedWithoutGrading(false)
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

  async function handleSubmit(event) { /* unchanged */
    event.preventDefault()
    setError('')
    setSubmitting(true)
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password })
    if (signInError) setError(signInError.message)
    else setPassword('')
    setSubmitting(false)
  }

  async function handleLogout() {
    setError('')
    setSubmitting(true)
    const { error: signOutError } = await supabase.auth.signOut()
    if (signOutError) setError(signOutError.message)
    setSubmitting(false)
  }

  async function openDrill(path) {
    setDrillLoading(true)
    setDrillError('')
    setSubmitMessage('')
    setAnswers({})
    setAttemptResult(null)
    setLegacyCompletedWithoutGrading(false)

    try {
      const response = await fetch(buildAssetUrl(path))
      if (!response.ok) throw new Error(`Could not load drill (${response.status}).`)
      const drillData = await response.json()
      const progressByUid = readDrillProgress()
      const existingProgress = progressByUid[drillData.drill_uid]

      setSelectedDrill(drillData)
      setAnswers(existingProgress?.answers ?? {})
      if (existingProgress?.completed) {
        if (hasGradedSummary(existingProgress)) {
          setAttemptResult(existingProgress)
          setSubmitMessage('This submitted attempt is locked. Website grading shown below.')
        } else {
          setSubmitMessage('This drill was completed before grading was added, so no grading data is available.')
          setLegacyCompletedWithoutGrading(true)
        }
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

  function handleChoiceChange(questionId, choiceId) { setAnswers((p) => { const n = { ...p, [questionId]: choiceId }; persistAnswers(n); return n }) }
  function handleTextChange(questionId, value) { setAnswers((p) => { const n = { ...p, [questionId]: value }; persistAnswers(n); return n }) }

  function clearAnswers() {
    if (!selectedDrill?.drill_uid) return
    setAnswers({})
    setSubmitMessage('')
    setAttemptResult(null)
    const progressByUid = readDrillProgress()
    const currentProgress = progressByUid[selectedDrill.drill_uid] ?? {}
    progressByUid[selectedDrill.drill_uid] = { ...currentProgress, answers: {}, completed: false }
    writeDrillProgress(progressByUid)
    setCompletedDrills((previous) => {
      const next = { ...previous }
      delete next[selectedDrill.drill_uid]
      return next
    })
  }


  function clearLegacyCompletion() {
    if (!selectedDrill?.drill_uid) return
    const progressByUid = readDrillProgress()
    delete progressByUid[selectedDrill.drill_uid]
    writeDrillProgress(progressByUid)

    setAnswers({})
    setAttemptResult(null)
    setLegacyCompletedWithoutGrading(false)
    setSubmitMessage('Legacy local completion cleared. You can submit this drill again.')
    setCompletedDrills((previous) => {
      const next = { ...previous }
      delete next[selectedDrill.drill_uid]
      return next
    })
  }

  function submitDrill(event) {
    event.preventDefault()
    if (!selectedDrill?.drill_uid) return
    const gradedAttempt = gradeDrill(selectedDrill, answers)
    const progressByUid = readDrillProgress()
    progressByUid[selectedDrill.drill_uid] = gradedAttempt
    writeDrillProgress(progressByUid)
    setCompletedDrills((previous) => ({ ...previous, [selectedDrill.drill_uid]: gradedAttempt }))
    setAttemptResult(gradedAttempt)
    setLegacyCompletedWithoutGrading(false)
    setSubmitMessage('Submitted. Website grading complete. Short-completion grading is preliminary.')
  }

  const resultMap = useMemo(() => Object.fromEntries((attemptResult?.results ?? []).map((result) => [result.question_id, result])), [attemptResult])
  const isSelectedDrillCompleted = Boolean(selectedDrill?.drill_uid && completedDrills[selectedDrill.drill_uid])

  return <main className="page"><section className="card" aria-busy={loading || submitting}><h1>Bunpou Web</h1><p className="subtitle">Japanese grammar drills</p>
  {loading ? <p className="status">Loading session...</p> : user ? <div className="dashboard">
    <p className="status">Signed in as <strong>{user.email}</strong></p>
    {manifestLoading ? <p className="status">Loading drills...</p> : null}
    {manifestError ? <p className="error" role="alert">{manifestError}</p> : null}
    {!manifestLoading && !manifestError && manifest && !selectedDrill ? <div className="drill-list" aria-live="polite"><h2>Available drills</h2>
      {manifest.drills?.length ? manifest.drills.map((drill) => {
        const completed = completedDrills[drill.drill_uid]
        const scoreText = completed?.summary ? `Completed: ${completed.summary.website_score}/${completed.summary.max_score}` : 'Completed'
        return <article key={drill.drill_uid} className="drill-card"><h3>{drill.title}</h3><p>{drill.description}</p><p className="meta">Questions: {drill.question_count}</p>{completed ? <p className="status-badge" aria-label="Completed">{scoreText}</p> : null}<button type="button" onClick={() => openDrill(drill.path)} disabled={drillLoading}>{completed ? 'Review drill' : 'Open drill'}</button></article>
      }) : <p className="status">No drills found.</p>}</div> : null}
    {drillLoading ? <p className="status">Loading drill...</p> : null}
    {drillError ? <p className="error" role="alert">{drillError}</p> : null}
    {selectedDrill ? <form className="drill-form" onSubmit={submitDrill}><h2>{selectedDrill.title}</h2><p>{selectedDrill.description}</p><p className="meta">Question count: {selectedDrill.question_count}</p>{isSelectedDrillCompleted ? <p className="status-badge">Completed (read only)</p> : null}
      {attemptResult?.summary ? <p className="score-summary">Website score: <strong>{attemptResult.summary.website_score}/{attemptResult.summary.max_score}</strong></p> : null}
      {selectedDrill.questions.map((question, index) => {
        const helperLines = Array.isArray(question.helper_text) ? question.helper_text : [question.use ? `Use the verb: ${question.use}` : null, question.intended_meaning ? `Intended meaning: ${question.intended_meaning}` : null].filter(Boolean)
        const result = resultMap[question.question_id]
        const correctChoice = question.type === 'multiple_choice' ? question.choices.find((choice) => choice.choice_id === question.answer?.correct_choice_id) : null
        return <fieldset key={question.question_id} className="question-block" disabled={isSelectedDrillCompleted}><p className="question-label">Question {index + 1}</p><p className="question-prompt">{question.prompt}</p>
          {question.type === 'multiple_choice' ? <div className="choices">{question.choices.map((choice) => { const isChecked = answers[question.question_id] === choice.choice_id; return <label key={choice.choice_id} className={`choice-row ${isChecked ? 'choice-row-selected' : ''}`}><input type="radio" name={question.question_id} value={choice.choice_id} checked={isChecked} onChange={() => handleChoiceChange(question.question_id, choice.choice_id)} disabled={isSelectedDrillCompleted} /><span>{choice.choice_id}. {choice.text}</span></label> })}</div> : <>{helperLines.length ? <div className="helper-text" aria-label="Hint">{helperLines.map((line) => <p key={line}>{line}</p>)}</div> : null}<input type="text" value={answers[question.question_id] ?? ''} onChange={(event) => handleTextChange(question.question_id, event.target.value)} placeholder="Type your answer" disabled={isSelectedDrillCompleted} /></>}
          {result ? <div className="result-panel"><p className={`result-status ${result.is_correct ? 'result-correct' : 'result-needs-review'}`}>{result.is_correct ? 'Correct' : result.website_result === 'needs_review' ? 'Needs review (website)' : 'Incorrect'} • {result.score}/{result.max_score}</p><p>Your answer: <strong>{String(result.user_answer ?? '—') || '—'}</strong></p>{question.type === 'multiple_choice' ? <p>Correct choice: <strong>{correctChoice ? `${correctChoice.choice_id}. ${correctChoice.text}` : question.answer?.correct_choice_id}</strong></p> : <><p>Accepted answers: <strong>{(question.answer?.accepted_answers ?? []).join(' / ')}</strong></p><p className="preliminary-note">Website grading for typed answers is preliminary and may be revised later.</p></>}<p>Explanation: {question.explanation}</p></div> : null}
        </fieldset>
      })}
      <div className="button-row"><button type="button" onClick={() => setSelectedDrill(null)}>Back to drill list</button><button type="button" onClick={clearAnswers} disabled={isSelectedDrillCompleted}>Clear answers</button><button type="submit" disabled={isSelectedDrillCompleted}>Submit</button></div>
      {legacyCompletedWithoutGrading ? (
        <button type="button" onClick={clearLegacyCompletion}>Clear local completion for this drill</button>
      ) : null}
      {submitMessage ? <p className="status success">{submitMessage}</p> : null}
    </form> : null}
    <button type="button" onClick={handleLogout} disabled={submitting}>{submitting ? 'Logging out...' : 'Logout'}</button></div> : <form className="form" onSubmit={handleSubmit}><label htmlFor="email">Email</label><input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /><label htmlFor="password">Password</label><input id="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /><button type="submit" disabled={submitting}>{submitting ? 'Logging in...' : 'Login'}</button></form>}
  {error ? <p className="error" role="alert">{error}</p> : null}</section></main>
}
