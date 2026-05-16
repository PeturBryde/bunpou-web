import { useEffect, useMemo, useState } from 'react'
import { supabase } from './supabase'
import {
  deleteDrillProgress,
  loadAttemptMap,
  loadProgressMap,
  readLocalProgress,
  saveDrillAttempt,
  saveDrillProgress,
  writeLocalProgress,
} from './lib/drillStorage'

function buildAssetUrl(path) {
  return `${import.meta.env.BASE_URL}${path}`
}

function isAttemptGraded(attempt) {
  return Boolean(attempt?.completed && attempt?.summary && Array.isArray(attempt?.results))
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
    attempt_id: `attempt_${drill.drill_uid}_${new Date().toISOString().replace(/[^\d]/g, '')}`,
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

export default function App() {
  const EXERCISE_HASH_KEY = 'exercise'
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
  const [progressDrills, setProgressDrills] = useState({})
  const [attemptResult, setAttemptResult] = useState(null)
  const [hashWarning, setHashWarning] = useState('')

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
      return
    }

    const localProgress = readLocalProgress()
    const completed = Object.fromEntries(
      Object.entries(localProgress).filter(([, progress]) => Boolean(progress?.completed))
    )
    setCompletedDrills(completed)
    setProgressDrills(Object.fromEntries(Object.entries(localProgress).filter(([, progress]) => Boolean(progress?.answers))))

    let active = true
    setManifestLoading(true)
    setManifestError('')

    fetch(buildAssetUrl('drills/manifest.json'))
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Could not load exercise manifest (${response.status}).`)
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

    Promise.allSettled([
      loadProgressMap(supabase, user.id),
      loadAttemptMap(supabase, user.id),
    ]).then(([progressResult, attemptsResult]) => {
      if (!active) return
      if (progressResult.status === 'fulfilled') {
        setProgressDrills(progressResult.value)
      } else {
        console.warn('Could not load remote drill progress.', progressResult.reason)
      }
      if (attemptsResult.status === 'fulfilled') {
        setCompletedDrills(attemptsResult.value)
      } else {
        console.warn('Could not load remote completed attempts.', attemptsResult.reason)
      }
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

    try {
      const response = await fetch(buildAssetUrl(path))
      if (!response.ok) throw new Error(`Could not load exercise (${response.status}).`)
      const drillData = await response.json()
      const localProgressByUid = readLocalProgress()
      const remoteAttempt = completedDrills[drillData.drill_uid]
      const remoteProgress = progressDrills[drillData.drill_uid]
      const localProgress = localProgressByUid[drillData.drill_uid]

      setSelectedDrill(drillData)
      if (remoteAttempt?.completed) {
        setAnswers(remoteAttempt.answers ?? {})
        setAttemptResult(remoteAttempt)
        if (isAttemptGraded(remoteAttempt)) {
          setSubmitMessage('This submitted attempt is locked. Website grading shown below.')
        } else {
          setSubmitMessage('This exercise was completed before grading was added, so no grading data is available.')
        }
      } else if (remoteProgress?.answers) {
        setAnswers(remoteProgress.answers)
      } else {
        setAnswers(localProgress?.answers ?? {})
      }
    } catch (openDrillError) {
      setDrillError(openDrillError.message)
    } finally {
      setDrillLoading(false)
    }
  }

  function setExerciseHash(drillUid) {
    const nextHash = `${EXERCISE_HASH_KEY}=${encodeURIComponent(drillUid)}`
    if (window.location.hash.slice(1) !== nextHash) {
      window.location.hash = nextHash
    }
  }

  function clearExerciseHash() {
    if (window.location.hash) {
      window.location.hash = ''
    }
  }

  function findManifestEntryByUid(drillUid) {
    return manifest?.drills?.find((item) => item.drill_uid === drillUid) ?? null
  }

  useEffect(() => {
    if (!user || !manifest?.drills?.length) return

    function openFromHash() {
      const hashValue = window.location.hash.replace(/^#/, '')
      if (!hashValue) {
        setSelectedDrill(null)
        setHashWarning('')
        return
      }

      const params = new URLSearchParams(hashValue)
      const hashDrillUid = params.get(EXERCISE_HASH_KEY)
      if (!hashDrillUid) return

      const drillEntry = findManifestEntryByUid(hashDrillUid)
      if (!drillEntry) {
        setSelectedDrill(null)
        setHashWarning(`Exercise "${hashDrillUid}" was not found.`)
        return
      }

      setHashWarning('')
      if (selectedDrill?.drill_uid !== hashDrillUid) {
        openDrill(drillEntry.path)
      }
    }

    openFromHash()
    window.addEventListener('hashchange', openFromHash)
    return () => window.removeEventListener('hashchange', openFromHash)
  }, [user, manifest, selectedDrill?.drill_uid])

  function persistAnswers(nextAnswers) {
    if (!selectedDrill?.drill_uid) return
    const progressByUid = readLocalProgress()
    const currentProgress = progressByUid[selectedDrill.drill_uid] ?? {}
    const nextProgress = {
      ...currentProgress,
      drill_uid: selectedDrill.drill_uid,
      drill_version: selectedDrill.version,
      answers: nextAnswers,
      completed: Boolean(currentProgress.completed),
      updated_at: new Date().toISOString(),
    }
    progressByUid[selectedDrill.drill_uid] = nextProgress
    writeLocalProgress(progressByUid)
    setProgressDrills((previous) => ({ ...previous, [selectedDrill.drill_uid]: nextProgress }))
    if (user?.id) {
      saveDrillProgress(supabase, user.id, selectedDrill.drill_uid, selectedDrill.version, nextProgress).catch((saveError) => {
        console.warn('Could not save remote drill progress.', saveError)
      })
    }
  }

  function handleChoiceChange(questionId, choiceId) { setAnswers((p) => { const n = { ...p, [questionId]: choiceId }; persistAnswers(n); return n }) }
  function handleTextChange(questionId, value) { setAnswers((p) => { const n = { ...p, [questionId]: value }; persistAnswers(n); return n }) }

  function clearAnswers() {
    if (!selectedDrill?.drill_uid) return
    setAnswers({})
    setSubmitMessage('')
    setAttemptResult(null)
    const progressByUid = readLocalProgress()
    delete progressByUid[selectedDrill.drill_uid]
    writeLocalProgress(progressByUid)
    setProgressDrills((previous) => {
      const next = { ...previous }
      delete next[selectedDrill.drill_uid]
      return next
    })
    if (user?.id) {
      deleteDrillProgress(supabase, user.id, selectedDrill.drill_uid).catch((deleteError) => {
        console.warn('Could not delete remote drill progress.', deleteError)
      })
    }
    setCompletedDrills((previous) => {
      const next = { ...previous }
      delete next[selectedDrill.drill_uid]
      return next
    })
  }

  function submitDrill(event) {
    event.preventDefault()
    if (!selectedDrill?.drill_uid || !user?.id || submitting) return

    const submitAttempt = async () => {
      setSubmitting(true)
      setSubmitMessage('')
      const completedAttempt = gradeDrill(selectedDrill, answers)

      try {
        const savedAttempt = await saveDrillAttempt(supabase, user.id, completedAttempt)
        await deleteDrillProgress(supabase, user.id, selectedDrill.drill_uid)

        const progressByUid = readLocalProgress()
        progressByUid[selectedDrill.drill_uid] = savedAttempt
        writeLocalProgress(progressByUid)

        setProgressDrills((previous) => {
          const next = { ...previous }
          delete next[selectedDrill.drill_uid]
          return next
        })
        setCompletedDrills((previous) => ({ ...previous, [selectedDrill.drill_uid]: savedAttempt }))
        setAttemptResult(savedAttempt)
        setSubmitMessage('Submitted. Website grading complete. Short-completion grading is preliminary.')
      } catch (submitError) {
        const isDuplicateAttempt = submitError?.code === '23505'
          || submitError?.message?.includes('drill_attempts_user_id_drill_uid_key')
          || submitError?.message?.includes('duplicate key value')

        if (isDuplicateAttempt) {
          try {
            const remoteAttempts = await loadAttemptMap(supabase, user.id)
            const existingAttempt = remoteAttempts[selectedDrill.drill_uid]
            if (existingAttempt) {
              setCompletedDrills((previous) => ({ ...previous, [selectedDrill.drill_uid]: existingAttempt }))
              setAttemptResult(existingAttempt)
              setAnswers(existingAttempt.answers ?? {})
            }
          } catch (loadError) {
            console.warn('Could not reload duplicate remote attempt.', loadError)
          }
          setSubmitMessage('This exercise has already been completed. Retakes are not supported.')
        } else {
          setSubmitMessage('Could not save completed attempt. Your answers are still saved as in progress. Please try again.')
        }
      } finally {
        setSubmitting(false)
      }
    }

    submitAttempt()
  }

  const resultMap = useMemo(() => Object.fromEntries((attemptResult?.results ?? []).map((result) => [result.question_id, result])), [attemptResult])
  const selectedDrillProgress = selectedDrill?.drill_uid ? completedDrills[selectedDrill.drill_uid] : null
  const isSelectedDrillCompleted = isAttemptGraded(selectedDrillProgress)
  const isLegacyCompletedWithoutGrading = Boolean(selectedDrillProgress?.completed && !isSelectedDrillCompleted)

  function clearLegacyCompletion() {
    if (!selectedDrill?.drill_uid) return
    const progressByUid = readLocalProgress()
    delete progressByUid[selectedDrill.drill_uid]
    writeLocalProgress(progressByUid)
    setCompletedDrills((previous) => {
      const next = { ...previous }
      delete next[selectedDrill.drill_uid]
      return next
    })
    setAnswers({})
    setAttemptResult(null)
    setSubmitMessage('')
  }

  return <main className="page"><section className="card" aria-busy={loading || submitting}><h1>Bunpou Web</h1><p className="subtitle">Japanese grammar exercises</p>
  {loading ? <p className="status">Loading session...</p> : user ? <div className="dashboard">
    <p className="status">Signed in as <strong>{user.email}</strong></p>
    {manifestLoading ? <p className="status">Loading exercises...</p> : null}
    {manifestError ? <p className="error" role="alert">{manifestError}</p> : null}
    {hashWarning ? <p className="status">{hashWarning}</p> : null}
    {!manifestLoading && !manifestError && manifest && !selectedDrill ? <div className="drill-list" aria-live="polite"><h2>Available exercises</h2>
      {manifest.drills?.length ? manifest.drills.map((drill) => {
        const completed = completedDrills[drill.drill_uid]
        const inProgress = progressDrills[drill.drill_uid]
        const scoreText = completed?.summary ? `Completed: ${completed.summary.website_score}/${completed.summary.max_score}` : 'Completed'
        const statusText = completed ? scoreText : inProgress ? 'In progress' : 'Not started'
        return <article key={drill.drill_uid} className="drill-card"><h3>{drill.title}</h3><p>{drill.description}</p><p className="meta">Questions: {drill.question_count}</p><p className="status-badge">{statusText}</p><button type="button" onClick={() => { setHashWarning(''); setExerciseHash(drill.drill_uid) }} disabled={drillLoading}>{completed ? 'Review exercise' : 'Open exercise'}</button></article>
      }) : <p className="status">No exercises found.</p>}</div> : null}
    {drillLoading ? <p className="status">Loading exercise...</p> : null}
    {drillError ? <p className="error" role="alert">{drillError}</p> : null}
    {selectedDrill ? <form className="drill-form" onSubmit={submitDrill}><h2>{selectedDrill.title}</h2><p>{selectedDrill.description}</p><p className="meta">Question count: {selectedDrill.question_count}</p>{isSelectedDrillCompleted ? <p className="status-badge">Completed (read only)</p> : null}
      {attemptResult?.summary ? <p className="score-summary">Website score: <strong>{attemptResult.summary.website_score}/{attemptResult.summary.max_score}</strong></p> : null}
      {isLegacyCompletedWithoutGrading ? <div className="status"><p>This exercise was completed before grading was added, so no grading data is available.</p><button type="button" onClick={clearLegacyCompletion}>Clear local completion for this exercise</button></div> : null}
      {selectedDrill.questions.map((question, index) => {
        const helperLines = Array.isArray(question.helper_text) ? question.helper_text : [question.use ? `Use the verb: ${question.use}` : null, question.intended_meaning ? `Intended meaning: ${question.intended_meaning}` : null].filter(Boolean)
        const result = resultMap[question.question_id]
        const correctChoice = question.type === 'multiple_choice' ? question.choices.find((choice) => choice.choice_id === question.answer?.correct_choice_id) : null
        return <fieldset key={question.question_id} className="question-block" disabled={isSelectedDrillCompleted}><p className="question-label">Question {index + 1}</p><p className="question-prompt">{question.prompt}</p>
          {question.type === 'multiple_choice' ? <div className="choices">{question.choices.map((choice) => { const isChecked = answers[question.question_id] === choice.choice_id; return <label key={choice.choice_id} className={`choice-row ${isChecked ? 'choice-row-selected' : ''}`}><input type="radio" name={question.question_id} value={choice.choice_id} checked={isChecked} onChange={() => handleChoiceChange(question.question_id, choice.choice_id)} disabled={isSelectedDrillCompleted} /><span>{choice.choice_id}. {choice.text}</span></label> })}</div> : <>{helperLines.length ? <div className="helper-text" aria-label="Hint">{helperLines.map((line) => <p key={line}>{line}</p>)}</div> : null}<input type="text" value={answers[question.question_id] ?? ''} onChange={(event) => handleTextChange(question.question_id, event.target.value)} placeholder="Type your answer" disabled={isSelectedDrillCompleted} /></>}
          {result ? <div className="result-panel"><p className={`result-status ${result.is_correct ? 'result-correct' : 'result-needs-review'}`}>{result.is_correct ? 'Correct' : result.website_result === 'needs_review' ? 'Needs review (website)' : 'Incorrect'} • {result.score}/{result.max_score}</p><p>Your answer: <strong>{String(result.user_answer ?? '—') || '—'}</strong></p>{question.type === 'multiple_choice' ? <p>Correct choice: <strong>{correctChoice ? `${correctChoice.choice_id}. ${correctChoice.text}` : question.answer?.correct_choice_id}</strong></p> : <><p>Accepted answers: <strong>{(question.answer?.accepted_answers ?? []).join(' / ')}</strong></p><p className="preliminary-note">Website grading for typed answers is preliminary and may be revised later.</p></>}<p>Explanation: {question.explanation}</p></div> : null}
        </fieldset>
      })}
      <div className="button-row"><button type="button" onClick={clearExerciseHash}>Back to exercise list</button><button type="button" onClick={clearAnswers} disabled={isSelectedDrillCompleted || submitting}>Clear answers</button><button type="submit" disabled={isSelectedDrillCompleted || submitting}>{submitting ? 'Submitting…' : 'Submit'}</button></div>
      {submitMessage ? <p className="status success">{submitMessage}</p> : null}
    </form> : null}
    <button type="button" onClick={handleLogout} disabled={submitting}>{submitting ? 'Logging out...' : 'Logout'}</button></div> : <form className="form" onSubmit={handleSubmit}><label htmlFor="email">Email</label><input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /><label htmlFor="password">Password</label><input id="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /><button type="submit" disabled={submitting}>{submitting ? 'Logging in...' : 'Login'}</button></form>}
  {error ? <p className="error" role="alert">{error}</p> : null}</section></main>
}
