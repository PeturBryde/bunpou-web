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
  loadUnimportedAttempts,
  markAttemptsExported,
  markExportBatchImported,
} from './lib/drillStorage'
import {
  archiveExercise,
  loadAllExercises,
  loadPublishedExercises,
  publishExercise,
  saveExercise,
} from './lib/exerciseStorage'

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

function buildQuestionSnapshot(question) {
  const snapshot = {
    question_id: question.question_id,
    question_type: question.type,
    target_uid: question.target_uid ?? null,
    target_title: question.target_title ?? null,
    prompt: question.prompt ?? '',
    explanation: question.explanation ?? '',
    validity: question.validity ?? null,
    points: question.points ?? 2,
    answer: question.answer ?? null,
  }

  if (typeof question.helper_text === 'string' && question.helper_text.length > 0) {
    snapshot.helper_text = question.helper_text
  }

  if (question.type === 'multiple_choice' && Array.isArray(question.choices)) {
    snapshot.choices = question.choices
  }

  return snapshot
}

function gradeDrill(drill, answers) {
  const maxScore = (drill.questions ?? []).reduce((total, question) => total + (question.points ?? 2), 0)
  const perQuestion = (drill.questions ?? []).map((question) => {
    const points = question.points ?? 2
    const rawAnswer = answers[question.question_id]
    const snapshot = buildQuestionSnapshot(question)

    if (question.type === 'multiple_choice') {
      const correctChoiceId = question.answer?.correct_choice_id
      const isCorrect = rawAnswer === correctChoiceId
      return {
        ...snapshot,
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
      ...snapshot,
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



function getLatestExportBatchInfo(attempts) {
  const exportedAttempts = attempts.filter((attempt) => attempt.last_export_batch_id && attempt.last_exported_at)
  if (!exportedAttempts.length) return null

  return exportedAttempts.reduce((latest, attempt) => {
    if (!latest) return attempt
    return new Date(attempt.last_exported_at) > new Date(latest.last_exported_at) ? attempt : latest
  }, null)
}

function sanitizeTimestampForId(isoTimestamp) {
  return isoTimestamp.replaceAll(':', '-').replaceAll('.', '-')
}

function downloadJsonFile(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

function validateExerciseJson(rawInput) {
  let parsed
  try {
    parsed = JSON.parse(rawInput)
  } catch (error) {
    return { ok: false, parsed: null, message: `Invalid JSON: ${error.message}` }
  }

  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    return { ok: false, parsed: null, message: 'Exercise JSON must be an object at the root.' }
  }
  if (typeof parsed.exercise_uid !== 'string' || parsed.exercise_uid.trim().length === 0) {
    return { ok: false, parsed: null, message: 'exercise_uid is required and must be a non-empty string.' }
  }
  if (!parsed.title) parsed.title = parsed.exercise_uid
  if (!Array.isArray(parsed.questions)) {
    return { ok: false, parsed: null, message: 'questions is required and must be an array.' }
  }

  for (let index = 0; index < parsed.questions.length; index += 1) {
    const question = parsed.questions[index]
    const label = `Question ${index + 1}`
    if (!question || typeof question !== 'object' || Array.isArray(question)) return { ok: false, parsed: null, message: `${label} must be an object.` }
    if (!(typeof question.question_id === 'string' && question.question_id) && !(typeof question.id === 'string' && question.id)) return { ok: false, parsed: null, message: `${label} needs question_id or id.` }
    if (typeof question.type !== 'string' || !question.type) return { ok: false, parsed: null, message: `${label} is missing type.` }
    if (typeof question.prompt !== 'string' || !question.prompt.trim()) return { ok: false, parsed: null, message: `${label} is missing prompt.` }
    if ('target_item_uid' in question) return { ok: false, parsed: null, message: `${label} uses deprecated field target_item_uid. Use target_uid instead.` }
    if (!('target_uid' in question)) return { ok: false, parsed: null, message: `${label} is missing required field target_uid.` }
    if (typeof question.target_uid !== 'string' || !question.target_uid.trim()) return { ok: false, parsed: null, message: `${label} must include a non-empty target_uid string.` }

    if (question.type === 'multiple_choice') {
      if (!Array.isArray(question.choices) || question.choices.length === 0) return { ok: false, parsed: null, message: `${label} multiple_choice must include a non-empty choices array.` }
      const hasAnswer = Boolean(question.answer?.correct_choice_id || question.correct_choice_id || question.correct_answer)
      if (!hasAnswer) return { ok: false, parsed: null, message: `${label} multiple_choice must include answer info (for example answer.correct_choice_id).` }
    }

    if (question.type === 'short_completion') {
      const hasAcceptedAnswers = Array.isArray(question.answer?.accepted_answers) && question.answer.accepted_answers.length > 0
      const hasAnswerInfo = Boolean(question.answer?.text || question.answer?.value || question.correct_answer)
      if (!hasAcceptedAnswers && !hasAnswerInfo) return { ok: false, parsed: null, message: `${label} short_completion needs accepted answers or answer info.` }
    }
  }

  return { ok: true, parsed, message: `Validation passed: ${parsed.questions.length} question(s).` }
}

export default function App() {
  const EXERCISE_HASH_KEY = 'exercise'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const [publishedExercises, setPublishedExercises] = useState([])
  const [allExercises, setAllExercises] = useState([])
  const [exercisesLoading, setExercisesLoading] = useState(false)
  const [exercisesError, setExercisesError] = useState('')
  const [managementLoading, setManagementLoading] = useState(false)
  const [managementError, setManagementError] = useState('')
  const [managementMessage, setManagementMessage] = useState('')
  const [validatedExercise, setValidatedExercise] = useState(null)
  const [isDropZoneActive, setIsDropZoneActive] = useState(false)
  const [lastUploadedFileName, setLastUploadedFileName] = useState('')

  const [selectedDrill, setSelectedDrill] = useState(null)
  const [drillLoading, setDrillLoading] = useState(false)
  const [drillError, setDrillError] = useState('')

  const [answers, setAnswers] = useState({})
  const [submitMessage, setSubmitMessage] = useState('')
  const [completedDrills, setCompletedDrills] = useState({})
  const [progressDrills, setProgressDrills] = useState({})
  const [attemptResult, setAttemptResult] = useState(null)
  const [hashWarning, setHashWarning] = useState('')
  const [unimportedAttempts, setUnimportedAttempts] = useState([])
  const [exportPanelLoading, setExportPanelLoading] = useState(false)
  const [exportWorking, setExportWorking] = useState(false)
  const [markImportedWorking, setMarkImportedWorking] = useState(false)
  const [exportMessage, setExportMessage] = useState('')
  const [exportError, setExportError] = useState('')

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
      setPublishedExercises([])
      setAllExercises([])
      setExercisesError('')
      setManagementError('')
      setManagementMessage('')
      setSelectedDrill(null)
      setDrillError('')
      setAnswers({})
      setSubmitMessage('')
      setCompletedDrills({})
      setAttemptResult(null)
      setUnimportedAttempts([])
      setExportMessage('')
      setExportError('')
      return
    }

    const localProgress = readLocalProgress()
    const completed = Object.fromEntries(
      Object.entries(localProgress).filter(([, progress]) => Boolean(progress?.completed))
    )
    setCompletedDrills(completed)
    setProgressDrills(Object.fromEntries(Object.entries(localProgress).filter(([, progress]) => Boolean(progress?.answers))))

    let active = true
    refreshExerciseLists().catch((loadError) => {
      if (!active) return
      setExercisesError(`Could not load exercises: ${loadError.message}`)
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

  async function refreshExerciseLists() {
    if (!user?.id) return
    setExercisesLoading(true)
    setManagementLoading(true)
    setExercisesError('')
    setManagementError('')

    const [publishedResult, allResult] = await Promise.allSettled([
      loadPublishedExercises(supabase, user.id),
      loadAllExercises(supabase, user.id),
    ])

    if (publishedResult.status === 'fulfilled') {
      const mappedExercises = publishedResult.value.map((row) => {
        const exerciseJson = typeof row.exercise_json === 'object' && row.exercise_json !== null ? row.exercise_json : {}
        const drillUid = row.exercise_uid ?? exerciseJson.exercise_uid
        const version = exerciseJson.version ?? row.exercise_version ?? 1
        const title = row.title ?? exerciseJson.title ?? drillUid ?? 'Untitled exercise'
        const description = row.description ?? exerciseJson.description ?? ''
        const level = row.level ?? exerciseJson.level ?? null
        const questions = Array.isArray(exerciseJson.questions) ? exerciseJson.questions : []
        return { ...exerciseJson, drill_uid: drillUid, version, title, description, level, questions, question_count: questions.length, exercise_uid: row.exercise_uid, exercise_version: row.exercise_version, status: row.status, updated_at: row.updated_at }
      })
      setPublishedExercises(mappedExercises)
    } else {
      setPublishedExercises([])
      setExercisesError(`Could not load published exercises: ${publishedResult.reason.message}`)
    }

    if (allResult.status === 'fulfilled') setAllExercises(allResult.value)
    else {
      setAllExercises([])
      setManagementError(`Could not load exercise management list: ${allResult.reason.message}`)
    }
    setExercisesLoading(false)
    setManagementLoading(false)
  }

  async function refreshUnimportedAttempts() {
    if (!user?.id) return

    try {
      setExportPanelLoading(true)
      const attempts = await loadUnimportedAttempts(supabase, user.id)
      setUnimportedAttempts(attempts)
    } catch (loadError) {
      setExportError(`Could not load exercise export status: ${loadError.message}`)
    } finally {
      setExportPanelLoading(false)
    }
  }

  useEffect(() => {
    if (!user?.id) return
    refreshUnimportedAttempts()
  }, [user?.id])

  async function handleExportResults() {
    if (!user?.id || !unimportedAttempts.length || exportWorking) return

    setExportWorking(true)
    setExportError('')
    setExportMessage('')

    try {
      const exportedAt = new Date().toISOString()
      const sanitizedTimestamp = sanitizeTimestampForId(exportedAt)
      const exportBatchId = `export_${sanitizedTimestamp}`
      const filename = `bunpou_results_export_${sanitizedTimestamp}.json`
      const payload = {
        schema_version: 'bunpou_results_export_v1',
        export_batch_id: exportBatchId,
        exported_at: exportedAt,
        source: {
          app: 'bunpou-web',
          app_version: '0.1.0',
          repo: 'PeturBryde/bunpou-web',
        },
        user: {
          user_id: user.id,
          email: user.email ?? '',
        },
        attempt_count: unimportedAttempts.length,
        attempts: unimportedAttempts.map((attempt) => ({
          attempt_id: attempt.attempt_id,
          drill_uid: attempt.drill_uid,
          drill_version: attempt.drill_version,
          completed_at: attempt.completed_at,
          result_json: attempt.result_json,
          summary_json: attempt.summary_json,
        })),
      }

      downloadJsonFile(filename, payload)
      await markAttemptsExported(
        supabase,
        user.id,
        unimportedAttempts.map((attempt) => attempt.attempt_id),
        exportBatchId,
        exportedAt
      )

      setExportMessage(`Downloaded ${filename}. Upload it to ChatGPT, then mark the latest export as imported after confirmation.`)
      await refreshUnimportedAttempts()
    } catch (exportErr) {
      setExportError(`Export failed: ${exportErr.message}`)
    } finally {
      setExportWorking(false)
    }
  }

  async function handleMarkLatestImported() {
    if (!user?.id || markImportedWorking) return
    const latestExport = getLatestExportBatchInfo(unimportedAttempts)
    if (!latestExport?.last_export_batch_id) return

    const confirmed = window.confirm('Only do this after ChatGPT successfully imported this export file. Mark this batch as imported?')
    if (!confirmed) return

    setMarkImportedWorking(true)
    setExportError('')
    setExportMessage('')

    try {
      await markExportBatchImported(supabase, user.id, latestExport.last_export_batch_id, new Date().toISOString())
      setExportMessage(`Marked export batch ${latestExport.last_export_batch_id} as imported.`)
      await refreshUnimportedAttempts()
    } catch (markError) {
      setExportError(`Could not mark latest export as imported: ${markError.message}`)
    } finally {
      setMarkImportedWorking(false)
    }
  }

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

  async function openDrill(drillData) {
    setDrillLoading(true)
    setDrillError('')
    setSubmitMessage('')
    setAnswers({})
    setAttemptResult(null)

    try {
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

  function findExerciseByUid(drillUid) {
    return publishedExercises.find((item) => item.drill_uid === drillUid) ?? null
  }

  useEffect(() => {
    if (!user || !publishedExercises.length) return

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

      const drillEntry = findExerciseByUid(hashDrillUid)
      if (!drillEntry) {
        setSelectedDrill(null)
        setHashWarning(`Exercise "${hashDrillUid}" was not found.`)
        return
      }

      setHashWarning('')
      if (selectedDrill?.drill_uid !== hashDrillUid) {
        openDrill(drillEntry)
      }
    }

    openFromHash()
    window.addEventListener('hashchange', openFromHash)
    return () => window.removeEventListener('hashchange', openFromHash)
  }, [user, publishedExercises, selectedDrill?.drill_uid])

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

  const latestExportBatch = getLatestExportBatchInfo(unimportedAttempts)
  const unimportedCount = unimportedAttempts.length

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

  function parseAndValidateExerciseJsonText(jsonText) {
    const result = validateExerciseJson(jsonText)
    if (result.ok) {
      setValidatedExercise(result.parsed)
      setManagementMessage(result.message)
      setManagementError('')
    } else {
      setValidatedExercise(null)
      setManagementMessage('')
      setManagementError(result.message)
    }
    return result
  }

  async function parseAndValidateExerciseFile(file) {
    if (!file) return
    try {
      const jsonText = await file.text()
      setLastUploadedFileName(file.name)
      parseAndValidateExerciseJsonText(jsonText)
    } catch (readError) {
      setValidatedExercise(null)
      setManagementMessage('')
      setManagementError(`Could not read file: ${readError.message}`)
    }
  }

  function handleDropZoneDragOver(event) {
    event.preventDefault()
    setIsDropZoneActive(true)
  }

  function handleDropZoneDragLeave(event) {
    event.preventDefault()
    setIsDropZoneActive(false)
  }

  async function handleDropZoneDrop(event) {
    event.preventDefault()
    setIsDropZoneActive(false)
    const file = event.dataTransfer?.files?.[0]
    if (!file) return
    await parseAndValidateExerciseFile(file)
  }

  async function handleExerciseFileChange(event) {
    const file = event.target.files?.[0]
    if (!file) return
    await parseAndValidateExerciseFile(file)
    event.target.value = ''
  }

  async function handleUploadAndPublishExercise() {
    if (!user?.id) return
    if (!validatedExercise) {
      setManagementError('Please upload a valid exercise JSON file before publishing.')
      return
    }

    try {
      setManagementLoading(true)
      setManagementError('')
      const saved = await saveExercise(supabase, user.id, validatedExercise, 'published')
      setManagementMessage(`Uploaded and published ${saved.exercise_uid}.`)
      await refreshExerciseLists()
    } catch (saveError) {
      setManagementError(`Could not upload exercise: ${saveError.message}`)
    } finally {
      setManagementLoading(false)
    }
  }

  async function handlePublishExisting(exerciseUid) {
    if (!user?.id) return
    try {
      setManagementLoading(true)
      setManagementError('')
      await publishExercise(supabase, user.id, exerciseUid)
      setManagementMessage(`Published ${exerciseUid}.`)
      await refreshExerciseLists()
    } catch (publishError) {
      setManagementError(`Could not publish ${exerciseUid}: ${publishError.message}`)
    } finally {
      setManagementLoading(false)
    }
  }

  async function handleArchiveExisting(exerciseUid) {
    if (!user?.id) return
    try {
      setManagementLoading(true)
      setManagementError('')
      await archiveExercise(supabase, user.id, exerciseUid)
      setManagementMessage(`Archived ${exerciseUid}.`)
      await refreshExerciseLists()
    } catch (archiveError) {
      setManagementError(`Could not archive ${exerciseUid}: ${archiveError.message}`)
    } finally {
      setManagementLoading(false)
    }
  }

  return <main className="page"><section className="card" aria-busy={loading || submitting}><h1>Bunpou Web</h1><p className="subtitle">Japanese grammar exercises</p>
  {loading ? <p className="status">Loading session...</p> : user ? <div className="dashboard">
    <p className="status">Signed in as <strong>{user.email}</strong></p>
    <section className="export-panel" aria-live="polite"><h2>Exercise results export</h2>
      {exportPanelLoading ? <p className="status">Loading export status...</p> : null}
      {!exportPanelLoading && !unimportedCount ? <p className="status">No completed exercise results waiting to export.</p> : null}
      {!exportPanelLoading && unimportedCount ? <p className="status">{unimportedCount} completed exercise {unimportedCount === 1 ? 'result' : 'results'} waiting to import.</p> : null}
      {latestExportBatch?.last_export_batch_id ? <div className="status"><p>Latest export batch: <strong>{latestExportBatch.last_export_batch_id}</strong></p><p>Exported at: {new Date(latestExportBatch.last_exported_at).toLocaleString()}</p><p>These results were exported and are still waiting to be marked as imported.</p></div> : null}
      <div className="button-row"><button type="button" onClick={handleExportResults} disabled={exportPanelLoading || exportWorking || !unimportedCount}>{exportWorking ? 'Exporting…' : 'Export results for ChatGPT'}</button>{latestExportBatch?.last_export_batch_id ? <button type="button" onClick={handleMarkLatestImported} disabled={markImportedWorking || exportPanelLoading}>{markImportedWorking ? 'Marking…' : 'Mark latest export as imported'}</button> : null}</div>
      {exportMessage ? <p className="status success">{exportMessage}</p> : null}
      {exportError ? <p className="error" role="alert">{exportError}</p> : null}
    </section>
    {exercisesLoading ? <p className="status">Loading published exercises...</p> : null}
    {exercisesError ? <p className="error" role="alert">{exercisesError}</p> : null}
    {hashWarning ? <p className="status">{hashWarning}</p> : null}
    {!exercisesLoading && !selectedDrill ? <div className="drill-list" aria-live="polite"><h2>Available exercises</h2>
      {publishedExercises.length ? publishedExercises.map((drill) => {
        const completed = completedDrills[drill.drill_uid]
        const inProgress = progressDrills[drill.drill_uid]
        const statusText = completed ? 'Completed' : inProgress ? 'In progress' : 'Not started'
        const ctaText = completed ? 'Review exercise' : inProgress ? 'Continue exercise' : 'Start exercise'
        return <article key={drill.drill_uid} className="drill-card"><h3>{drill.title}</h3><p>{drill.description}</p><div className="drill-meta-row"><p className="meta"><span className="meta-label">Questions:</span> {drill.question_count}</p><p className="meta"><span className="meta-label">Status:</span> {statusText}</p>{completed?.summary ? <p className="meta"><span className="meta-label">Score:</span> {completed.summary.website_score}/{completed.summary.max_score}</p> : null}</div><button type="button" onClick={() => { setHashWarning(''); setExerciseHash(drill.drill_uid) }} disabled={drillLoading}>{ctaText}</button></article>
      }) : <p className="status">No published exercises yet.</p>}</div> : null}
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
    <section className="management-panel" aria-live="polite"><h2>Upload exercises</h2><p className="status">Upload JSON exercises to publish them, then manage published/archive status below.</p><div className={`drop-zone ${isDropZoneActive ? 'drop-zone-active' : ''}`} onDragOver={handleDropZoneDragOver} onDragLeave={handleDropZoneDragLeave} onDrop={handleDropZoneDrop}><p>Drag a JSON exercise file here, or choose a file.</p><label className="file-picker-label">Choose JSON file<input type="file" accept=".json,application/json" onChange={handleExerciseFileChange} /></label>{lastUploadedFileName ? <p className="meta">Loaded file: {lastUploadedFileName}</p> : null}</div><div className="button-row"><button type="button" onClick={handleUploadAndPublishExercise} disabled={managementLoading || !validatedExercise}>Upload and publish</button></div>{validatedExercise ? <div className="status"><p>Ready to upload:</p><p><strong>{validatedExercise.title ?? validatedExercise.exercise_uid}</strong></p><p className="meta">UID: {validatedExercise.exercise_uid} • Level: {validatedExercise.level ?? '—'} • Version: {validatedExercise.version ?? 1} • Questions: {Array.isArray(validatedExercise.questions) ? validatedExercise.questions.length : 0}</p></div> : null}{managementMessage ? <p className="status success">{managementMessage}</p> : null}{managementError ? <p className="error" role="alert">{managementError}</p> : null}{managementLoading ? <p className="status">Updating exercise list...</p> : null}<div className="management-list"><h3>Existing exercises</h3>{allExercises.length ? allExercises.map((exercise) => { const count = Array.isArray(exercise.exercise_json?.questions) ? exercise.exercise_json.questions.length : 0; return <article key={exercise.exercise_uid} className="drill-card"><p><strong>{exercise.title ?? exercise.exercise_uid}</strong></p><p className="meta">UID: {exercise.exercise_uid}</p><p className="meta">Level: {exercise.level ?? '—'} • Status: {exercise.status} • Version: {exercise.exercise_version}</p><p className="meta">Updated: {new Date(exercise.updated_at).toLocaleString()} • Questions: {count}</p><div className="button-row">{exercise.status !== 'published' ? <button type="button" onClick={() => handlePublishExisting(exercise.exercise_uid)} disabled={managementLoading}>Publish</button> : null}{exercise.status !== 'archived' ? <button type="button" onClick={() => handleArchiveExisting(exercise.exercise_uid)} disabled={managementLoading}>Archive</button> : null}</div></article> }) : <p className="status">No exercises found in Supabase yet.</p>}</div></section><button type="button" onClick={handleLogout} disabled={submitting}>{submitting ? 'Logging out...' : 'Logout'}</button></div> : <form className="form" onSubmit={handleSubmit}><label htmlFor="email">Email</label><input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /><label htmlFor="password">Password</label><input id="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /><button type="submit" disabled={submitting}>{submitting ? 'Logging in...' : 'Login'}</button></form>}
  {error ? <p className="error" role="alert">{error}</p> : null}</section></main>
}
