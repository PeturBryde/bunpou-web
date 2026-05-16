const DRILL_PROGRESS_KEY = 'bunpouWeb.drillProgress.v1'

export function readLocalProgress() {
  try {
    const raw = localStorage.getItem(DRILL_PROGRESS_KEY)
    if (!raw) return {}

    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

export function writeLocalProgress(progressByUid) {
  localStorage.setItem(DRILL_PROGRESS_KEY, JSON.stringify(progressByUid))
}

export async function loadProgressMap(supabase, userId) {
  const { data, error } = await supabase
    .from('drill_progress')
    .select('drill_uid,drill_version,progress_json,updated_at')
    .eq('user_id', userId)

  if (error) throw error

  return Object.fromEntries(
    (data ?? []).map((row) => [
      row.drill_uid,
      {
        drill_uid: row.drill_uid,
        drill_version: row.drill_version,
        ...(row.progress_json ?? {}),
        updated_at: row.updated_at,
      },
    ])
  )
}

export async function loadAttemptMap(supabase, userId) {
  const { data, error } = await supabase
    .from('drill_attempts')
    .select('attempt_id,drill_uid,drill_version,result_json,summary_json,completed_at')
    .eq('user_id', userId)

  if (error) throw error

  return Object.fromEntries((data ?? []).map((row) => [row.drill_uid, normalizeAttemptRow(row)]))
}

export function normalizeAttemptRow(row) {
  return {
    completed: row.result_json?.completed ?? true,
    attempt_id: row.attempt_id ?? row.result_json?.attempt_id ?? null,
    drill_uid: row.drill_uid,
    drill_version: row.drill_version,
    answers: row.result_json?.answers ?? {},
    results: row.result_json?.results ?? [],
    summary: row.result_json?.summary ?? row.summary_json ?? null,
    completed_at: row.result_json?.completed_at ?? row.completed_at ?? null,
  }
}

export async function saveDrillProgress(supabase, userId, drillUid, drillVersion, progressJson) {
  const payload = {
    user_id: userId,
    drill_uid: drillUid,
    drill_version: drillVersion,
    progress_json: progressJson,
    updated_at: new Date().toISOString(),
  }

  const { error } = await supabase.from('drill_progress').upsert(payload)
  if (error) throw error
}

export async function deleteDrillProgress(supabase, userId, drillUid) {
  const { error } = await supabase
    .from('drill_progress')
    .delete()
    .eq('user_id', userId)
    .eq('drill_uid', drillUid)

  if (error) throw error
}

export async function saveDrillAttempt(supabase, userId, attempt) {
  const payload = {
    user_id: userId,
    attempt_id: attempt.attempt_id,
    drill_uid: attempt.drill_uid,
    drill_version: attempt.drill_version,
    completed_at: attempt.completed_at,
    result_json: attempt,
    summary_json: attempt.summary ?? null,
  }

  const { data, error } = await supabase
    .from('drill_attempts')
    .insert(payload)
    .select('attempt_id,drill_uid,drill_version,result_json,summary_json,completed_at')
    .single()

  if (error) throw error
  return normalizeAttemptRow(data)
}
