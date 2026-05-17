const EXERCISE_SELECT =
  'exercise_uid,exercise_version,title,description,level,status,exercise_json,updated_at'

export async function loadPublishedExercises(supabase, userId) {
  const { data, error } = await supabase
    .from('exercises')
    .select(EXERCISE_SELECT)
    .eq('user_id', userId)
    .eq('status', 'published')
    .order('updated_at', { ascending: false })

  if (error) throw error
  return data ?? []
}

export async function loadAllExercises(supabase, userId) {
  const { data, error } = await supabase
    .from('exercises')
    .select(EXERCISE_SELECT)
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })

  if (error) throw error
  return data ?? []
}

export async function saveExercise(supabase, userId, exerciseJson, status = 'draft') {
  const exerciseUid = exerciseJson?.exercise_uid

  if (!exerciseUid) {
    throw new Error('Exercise JSON is missing exercise_uid.')
  }

  const payload = {
    user_id: userId,
    exercise_uid: exerciseUid,
    exercise_version: exerciseJson.version ?? exerciseJson.exercise_version ?? 1,
    title: exerciseJson.title ?? exerciseUid,
    description: exerciseJson.description ?? null,
    level: exerciseJson.level ?? null,
    status,
    exercise_json: exerciseJson,
    updated_at: new Date().toISOString(),
  }

  const { data, error } = await supabase
    .from('exercises')
    .upsert(payload)
    .select(EXERCISE_SELECT)
    .single()

  if (error) throw error
  return data
}

export async function publishExercise(supabase, userId, exerciseUid) {
  return updateExerciseStatus(supabase, userId, exerciseUid, 'published')
}

export async function archiveExercise(supabase, userId, exerciseUid) {
  return updateExerciseStatus(supabase, userId, exerciseUid, 'archived')
}

export async function updateExerciseStatus(supabase, userId, exerciseUid, status) {
  const { data, error } = await supabase
    .from('exercises')
    .update({
      status,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId)
    .eq('exercise_uid', exerciseUid)
    .select(EXERCISE_SELECT)
    .single()

  if (error) throw error
  return data
}
