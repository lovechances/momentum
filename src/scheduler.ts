import type { AppData, Evidence, EvidenceCadence, EvidenceKind, Goal, PeriodRecord, ProgressEntry, Reminder, ReminderOccurrence, Routine, RoutineExclusion, Task, Win } from './domain'
import { evidenceGoalIds, localDateOf, now, recordedDateOf, todayLocal } from './domain'
import { isDeadlineReviewDue } from './goals'
import { evidenceCaptureGroups } from './evidence-captures'

export const dateAtLocalMidnight = (value: string) => new Date(`${value}T00:00:00`)

export const addDays = (date: string, amount: number) => {
  const result = dateAtLocalMidnight(date)
  result.setDate(result.getDate() + amount)
  return todayLocal(result)
}

/** Calendar-aware month addition, clamped to the destination month's last day. */
export const addMonths = (date: string, amount: number) => {
  const result = dateAtLocalMidnight(date)
  const originalDay = result.getDate()
  result.setDate(1)
  result.setMonth(result.getMonth() + amount)
  const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate()
  result.setDate(Math.min(originalDay, lastDay))
  return todayLocal(result)
}

export const startOfWeek = (date: string) => {
  const weekday = dateAtLocalMidnight(date).getDay()
  return addDays(date, -((weekday + 6) % 7))
}
export const endOfWeek = (date: string) => addDays(startOfWeek(date), 6)
export const startOfMonth = (date: string) => `${date.slice(0, 7)}-01`
export const endOfMonth = (date: string) => addDays(addMonths(startOfMonth(date), 1), -1)
export const startOfQuarter = (date: string) => {
  const result = dateAtLocalMidnight(date)
  result.setMonth(Math.floor(result.getMonth() / 3) * 3, 1)
  return todayLocal(result)
}
export const endOfQuarter = (date: string) => addDays(addMonths(startOfQuarter(date), 3), -1)
export const startOfHalf = (date: string) => {
  const result = dateAtLocalMidnight(date)
  result.setMonth(result.getMonth() < 6 ? 0 : 6, 1)
  return todayLocal(result)
}
export const endOfHalf = (date: string) => addDays(addMonths(startOfHalf(date), 6), -1)
export const startOfYear = (date: string) => `${date.slice(0, 4)}-01-01`
export const endOfYear = (date: string) => `${date.slice(0, 4)}-12-31`

export function isRoutineDue(routine: Routine, date: string) {
  if (!routine.active || localDateOf(routine.createdAt) > date) return false
  const weekday = dateAtLocalMidnight(date).getDay()
  if (routine.recurrence.type === 'daily') return true
  if (routine.recurrence.type === 'weekdays') return weekday > 0 && weekday < 6
  return routine.recurrence.weekdays?.includes(weekday) ?? false
}

export const routineTaskId = (routineId: string, date: string) => `routine:${routineId}:${date}`

export function generateRoutineTasks(routines: Routine[], tasks: Task[], date = todayLocal(), exclusions: RoutineExclusion[] = []): Task[] {
  const todayTasks = tasks.filter(task => task.dueDate === date)
  const existingSources = new Set(todayTasks.flatMap(task => task.sourceRoutineId ? [task.sourceRoutineId] : []))
  const existingIds = new Set(todayTasks.map(task => task.id))
  // A schema-1/early schema-2 routine instance may not have sourceRoutineId. Only
  // routine-kind title matching is used for that migration case; a normal task
  // with the same title must not suppress the routine.
  const legacyRoutineTitles = new Set(
    todayTasks
      .filter(task => task.kind === 'routine' && !task.sourceRoutineId)
      .map(task => task.title.trim().toLowerCase()),
  )

  return routines
    .filter(routine => {
      const id = routineTaskId(routine.id, date)
      return isRoutineDue(routine, date)
        && !exclusions.some(exclusion => exclusion.routineId === routine.id && exclusion.date === date)
        && !existingSources.has(routine.id)
        && !existingIds.has(id)
        && !legacyRoutineTitles.has(routine.title.trim().toLowerCase())
    })
    .map(routine => ({
      id: routineTaskId(routine.id, date),
      title: routine.title,
      section: routine.section,
      done: false,
      kind: 'routine',
      goalId: routine.goalId,
      dueDate: date,
      sourceRoutineId: routine.id,
      createdAt: now(),
      carriedCount: 0,
      status: 'active',
    }))
}

export const routineExclusionId = (routineId: string, date: string) => `routine-exclusion:${routineId}:${date}`

/** Preserve a moved routine occurrence while preventing either date from regenerating unexpectedly. */
export function updateTaskInData(data: AppData, task: Task, at = now()): AppData {
  const previous = data.tasks.find(item => item.id === task.id)
  if (!previous) return data
  let routineExclusions = data.routineExclusions
  const previousRoutineId = previous.sourceRoutineId
  const displacedRoutineOccurrence = previousRoutineId
    && (task.sourceRoutineId !== previousRoutineId || previous.dueDate !== task.dueDate)
  if (previousRoutineId && displacedRoutineOccurrence) {
    const oldDateExclusion = { id: routineExclusionId(previousRoutineId, previous.dueDate), routineId: previousRoutineId, date: previous.dueDate, createdAt: at }
    routineExclusions = [
      ...routineExclusions.filter(item => task.sourceRoutineId !== previousRoutineId
        || !(item.routineId === previousRoutineId && item.date === task.dueDate)),
      ...routineExclusions.some(item => item.id === oldDateExclusion.id) ? [] : [oldDateExclusion],
    ]
  }
  return {
    ...data,
    routineExclusions,
    tasks: data.tasks.map(item => item.id === task.id ? { ...task, history: [...(item.history ?? []), { at, action: 'edited', title: item.title, details: item.details, section: item.section, dueDate: item.dueDate, kind: item.kind, goalId: item.goalId }] } : item),
  }
}

export function excludeRoutineOccurrence(data: AppData, taskId: string, at = now()): AppData {
  const task = data.tasks.find(item => item.id === taskId)
  if (!task?.sourceRoutineId) return data
  const exclusion: RoutineExclusion = { id: routineExclusionId(task.sourceRoutineId, task.dueDate), routineId: task.sourceRoutineId, date: task.dueDate, createdAt: at }
  return {
    ...data,
    routineExclusions: data.routineExclusions.some(item => item.id === exclusion.id) ? data.routineExclusions : [...data.routineExclusions, exclusion],
    tasks: data.tasks.map(item => item.id === taskId ? { ...item, status: 'excluded', resolvedAt: at, history: [...(item.history ?? []), { at, action: 'excluded' }] } : item),
  }
}

export function restoreRoutineOccurrence(data: AppData, taskId: string, at = now()): AppData {
  const task = data.tasks.find(item => item.id === taskId)
  if (!task?.sourceRoutineId) return data
  const exclusionId = routineExclusionId(task.sourceRoutineId, task.dueDate)
  return {
    ...data,
    routineExclusions: data.routineExclusions.filter(item => item.id !== exclusionId),
    tasks: data.tasks.map(item => item.id === taskId ? { ...item, status: 'active', resolvedAt: undefined, history: [...(item.history ?? []), { at, action: 'restored' }] } : item),
  }
}

/** Apply routine-template edits prospectively without rewriting today's commitment. */
export function syncRoutineTaskInstances(tasks: Task[], routine: Routine, date = todayLocal()) {
  return tasks.flatMap(task => {
    if (task.sourceRoutineId !== routine.id || task.dueDate <= date || task.done || task.resolvedAt) return [task]
    if (!isRoutineDue(routine, task.dueDate)) return []
    return [{ ...task, title: routine.title, section: routine.section, goalId: routine.goalId }]
  })
}

/** Removing a template preserves past/completed history but removes unresolved generated work. */
export function removeRoutineTaskInstances(tasks: Task[], routineId: string, date = todayLocal()) {
  return tasks.filter(task =>
    task.sourceRoutineId !== routineId
    || task.dueDate < date
    || task.done
    || Boolean(task.resolvedAt),
  )
}

/** Reorder generated routine rows without disturbing the positions of one-off work. */
export function orderRoutineTasksForDisplay(tasks: Task[], routines: Routine[]) {
  const order = new Map(routines.map((routine, index) => [routine.id, index]))
  const orderedRoutines = tasks
    .map((task, index) => ({ task, index }))
    .filter(({ task }) => task.sourceRoutineId && order.has(task.sourceRoutineId))
    .sort((left, right) =>
      (order.get(left.task.sourceRoutineId!) ?? Number.MAX_SAFE_INTEGER)
      - (order.get(right.task.sourceRoutineId!) ?? Number.MAX_SAFE_INTEGER)
      || left.index - right.index,
    )
    .map(({ task }) => task)
  let nextRoutine = 0
  return tasks.map(task => task.sourceRoutineId && order.has(task.sourceRoutineId)
    ? orderedRoutines[nextRoutine++]
    : task)
}

/** Every unresolved one-off from before today is recoverable, even after days away. */
export function rolloverCandidates(tasks: Task[], date = todayLocal()) {
  return tasks.filter(task =>
    task.dueDate < date
    && !task.done
    && !task.sourceRoutineId
    && (task.status ?? 'active') === 'active',
  )
}

export function resolveRollover(task: Task, action: 'carry' | 'drop', date = todayLocal(), at = now()) {
  if (task.done || task.sourceRoutineId || (task.status ?? 'active') !== 'active' || task.dueDate >= date) {
    throw new Error('Only an unresolved overdue one-off can be reviewed.')
  }
  if (action === 'drop') {
    return { original: { ...task, status: 'dropped' as const, resolvedAt: at }, next: undefined }
  }
  const nextId = `${task.id}:rollover:${date}`
  return {
    original: { ...task, status: 'rolled' as const, resolvedAt: at, rolledToId: nextId },
    next: {
      ...task,
      id: nextId,
      dueDate: date,
      done: false,
      sourceRoutineId: undefined,
      createdAt: at,
      carriedCount: task.carriedCount + 1,
      status: 'active' as const,
      resolvedAt: undefined,
      rolledToId: undefined,
    },
  }
}

export const nextEvidenceDate = (capturedDate: string, cadence: EvidenceCadence) => {
  if (cadence === 'weekly') return addDays(capturedDate, 7)
  return addMonths(capturedDate, cadence === 'monthly' ? 1 : 3)
}

type EvidenceSchedule = Goal['evidenceSchedules'][number]
type ScheduledEvidence = { goal: Goal; schedule: EvidenceSchedule }
type DueEvidence = ScheduledEvidence & { dueDate: string; trackId: string; occurrenceId: string }

export const MAX_VISIBLE_EVIDENCE_PROMPTS = 3

export function evidencePromptWindow<T>(items: T[]) {
  return {
    visible: items.slice(0, MAX_VISIBLE_EVIDENCE_PROMPTS),
    hiddenCount: Math.max(0, items.length - MAX_VISIBLE_EVIDENCE_PROMPTS),
  }
}

/** Only an explicitly shared history can share a capture prompt. */
export function evidenceTrackKey(item: ScheduledEvidence) {
  const { goal, schedule } = item
  const sameKindSchedules = goal.evidenceSchedules.filter(candidate =>
    candidate.kind === schedule.kind
    && candidate.cadence === schedule.cadence,
  )
  if (schedule.historyId && sameKindSchedules.length === 1) {
    return JSON.stringify(['history', schedule.historyId, schedule.kind, schedule.cadence])
  }
  return JSON.stringify(['goal', goal.id, schedule.id])
}

export function matchingEvidenceSchedule(goal: Goal, kind: EvidenceKind, cadence: EvidenceCadence) {
  const matching = goal.evidenceSchedules.filter(schedule => schedule.kind === kind && schedule.cadence === cadence)
  return matching.find(schedule => schedule.active) ?? matching[0]
}

function occurrenceReferenceDate(item: ReminderOccurrence) {
  if (item.status === 'snoozed' && item.snoozedUntil) return item.snoozedUntil
  return item.handledAt ? localDateOf(item.handledAt) : item.dueDate
}

/** Preserve handled/snoozed state when a schedule's shared-track identity changes. */
export function remapEvidenceReminderOccurrences(
  occurrences: ReminderOccurrence[],
  trackChanges: Map<string, string>,
) {
  const stateRank: Record<ReminderOccurrence['status'], number> = { due: 0, snoozed: 1, skipped: 2, satisfied: 3 }
  const merged = new Map<string, ReminderOccurrence>()
  for (const item of occurrences) {
    const trackId = trackChanges.get(item.trackId) ?? item.trackId
    const candidate = trackId === item.trackId
      ? item
      : { ...item, id: `evidence:${trackId}:${item.dueDate}`, trackId }
    const existing = merged.get(candidate.id)
    if (!existing
      || occurrenceReferenceDate(candidate) > occurrenceReferenceDate(existing)
      || (occurrenceReferenceDate(candidate) === occurrenceReferenceDate(existing)
        && stateRank[candidate.status] > stateRank[existing.status])) {
      merged.set(candidate.id, candidate)
    }
  }
  return [...merged.values()]
}

export function updateEvidenceScheduleTrackInData(
  data: AppData,
  goalId: string,
  scheduleId: string,
  change: { active?: boolean; cadence?: EvidenceCadence; remove?: boolean },
) {
  const sourceGoal = data.goals.find(goal => goal.id === goalId)
  const sourceSchedule = sourceGoal?.evidenceSchedules.find(schedule => schedule.id === scheduleId)
  if (!sourceGoal || !sourceSchedule) return data
  const sourceTrackId = evidenceTrackKey({ goal: sourceGoal, schedule: sourceSchedule })
  const members = data.goals.flatMap(goal => goal.evidenceSchedules.flatMap(schedule => {
    const sameTrack = evidenceTrackKey({ goal, schedule }) === sourceTrackId
    return (sameTrack || (goal.id === goalId && schedule.id === scheduleId)) ? [{ goal, schedule }] : []
  }))
  const memberKeys = new Set(members.map(({ goal, schedule }) => `${goal.id}:${schedule.id}`))
  const targetCadence = change.cadence
  const sourceMemberByGoal = new Map(members.map(member => [member.goal.id, member]))
  const collisions = !change.remove && targetCadence && targetCadence !== sourceSchedule.cadence
    ? data.goals.flatMap(goal => {
      if (!sourceMemberByGoal.has(goal.id)) return []
      return goal.evidenceSchedules.flatMap(schedule =>
        !memberKeys.has(`${goal.id}:${schedule.id}`)
          && schedule.kind === sourceSchedule.kind
          && schedule.cadence === targetCadence
          && (sourceSchedule.historyId ? schedule.historyId === sourceSchedule.historyId : goal.id === sourceGoal.id)
          ? [{ goal, schedule }]
          : [])
    })
    : []
  const collisionKeys = new Set(collisions.map(({ goal, schedule }) => `${goal.id}:${schedule.id}`))
  const removedScheduleIds = new Map(collisions.flatMap(({ goal, schedule }) => {
    const keeper = sourceMemberByGoal.get(goal.id)?.schedule
    return keeper ? [[schedule.id, keeper.id] as const] : []
  }))
  const goals = data.goals.map(goal => ({
    ...goal,
    evidenceSchedules: goal.evidenceSchedules.flatMap(schedule => {
      if (collisionKeys.has(`${goal.id}:${schedule.id}`)) return []
      if (!memberKeys.has(`${goal.id}:${schedule.id}`)) return [schedule]
      if (change.remove) return []
      const merged = collisions.filter(item => item.goal.id === goal.id).map(item => item.schedule)
      const firstDueDate = [schedule, ...merged].flatMap(item => item.firstDueDate ? [item.firstDueDate] : []).sort()[0]
      const lastCapturedAt = [schedule, ...merged].flatMap(item => item.lastCapturedAt ? [item.lastCapturedAt] : []).sort().at(-1)
      return [{
        ...schedule,
        active: change.active ?? (schedule.active || merged.some(item => item.active)),
        cadence: change.cadence ?? schedule.cadence,
        firstDueDate,
        lastCapturedAt,
        provenance: 'manual' as const,
      }]
    }),
  }))
  if (change.remove) {
    const removedScheduleIds = new Set(members.map(({ schedule }) => schedule.id))
    return {
      ...data,
      goals,
      evidence: data.evidence.map(item => item.scheduleId && removedScheduleIds.has(item.scheduleId)
        ? { ...item, scheduleId: undefined }
        : item),
      reminderOccurrences: data.reminderOccurrences.filter(item =>
        item.trackId !== sourceTrackId && !removedScheduleIds.has(item.scheduleId)),
    }
  }
  const trackChanges = new Map<string, string>()
  for (const { goal, schedule } of members) {
    const nextGoal = goals.find(item => item.id === goal.id)!
    const nextSchedule = nextGoal.evidenceSchedules.find(item => item.id === schedule.id)!
    trackChanges.set(evidenceTrackKey({ goal, schedule }), evidenceTrackKey({ goal: nextGoal, schedule: nextSchedule }))
  }
  for (const { goal, schedule } of collisions) {
    const keeper = sourceMemberByGoal.get(goal.id)?.schedule
    const nextGoal = goals.find(item => item.id === goal.id)
    const nextSchedule = keeper && nextGoal?.evidenceSchedules.find(item => item.id === keeper.id)
    if (nextGoal && nextSchedule) {
      trackChanges.set(evidenceTrackKey({ goal, schedule }), evidenceTrackKey({ goal: nextGoal, schedule: nextSchedule }))
    }
  }
  const reminderOccurrences = remapEvidenceReminderOccurrences(data.reminderOccurrences, trackChanges)
    .map(item => removedScheduleIds.has(item.scheduleId) ? { ...item, scheduleId: removedScheduleIds.get(item.scheduleId)! } : item)
  return {
    ...data,
    goals,
    evidence: removedScheduleIds.size
      ? data.evidence.map(item => item.scheduleId && removedScheduleIds.has(item.scheduleId)
        ? { ...item, scheduleId: removedScheduleIds.get(item.scheduleId) }
        : item)
      : data.evidence,
    reminderOccurrences,
  }
}

function inferredScheduleProvenance(goal: Goal, schedule: EvidenceSchedule): NonNullable<EvidenceSchedule['provenance']> {
  if (schedule.provenance) return schedule.provenance
  // The noisy release generated exact, deterministic IDs. UUID/manual IDs and
  // any cadence/kind edits deliberately remain ambiguous and are preserved.
  const firstDueMatches = !schedule.firstDueDate || schedule.firstDueDate === localDateOf(goal.createdAt)
  const generatedShape = firstDueMatches && schedule.active && (
    (schedule.id === `${goal.id}-note-weekly` && schedule.kind === 'note' && schedule.cadence === 'weekly')
    || (schedule.id === `${goal.id}-number-weekly` && schedule.kind === 'number' && schedule.cadence === 'weekly')
    || (schedule.id === `${goal.id}-photo-monthly` && schedule.kind === 'photo' && schedule.cadence === 'monthly')
  )
  return generatedShape ? 'auto-default' : 'legacy-unknown'
}

export function isCurrentExecutionGoal(data: AppData, goal: Goal, date = todayLocal()) {
  if (goal.status !== 'active' || goal.horizon !== '1M' || goal.kind === 'numeric') return false
  const recentStart = addDays(date, -14)
  const nearFuture = addDays(date, 7)
  const recentTask = data.tasks.some(task => task.goalId === goal.id
    && task.kind !== 'routine'
    && !['dropped', 'excluded', 'deleted'].includes(task.status ?? 'active')
    && task.dueDate >= recentStart
    && task.dueDate <= nearFuture)
  const recentProgress = goal.history.some(event => ['progressed', 'milestone'].includes(event.action)
    && localDateOf(event.at) >= recentStart
    && localDateOf(event.at) <= date)
  return recentTask || recentProgress
}

function autoScheduleAllowed(data: AppData, goal: Goal, schedule: EvidenceSchedule, date: string) {
  const history = schedule.historyId
    ? data.measurementHistories.find(item => item.id === schedule.historyId && !item.mergedIntoId)
    : undefined
  const sharedHistory = Boolean(schedule.historyId && data.goals.filter(item =>
    item.status === 'active' && item.measurementHistoryId === schedule.historyId).length > 1)
  if (schedule.kind === 'number' && schedule.cadence === 'weekly'
    && (sharedHistory || history?.semanticKey === 'body-weight' || history?.semanticKey === 'savings-balance')) return true
  if (schedule.kind === 'photo' && schedule.cadence === 'monthly' && history?.semanticKey === 'body-weight') return true
  if (schedule.kind === 'screenshot' && schedule.cadence === 'monthly' && history?.semanticKey === 'savings-balance') return !schedule.active
  return schedule.kind === 'note' && schedule.cadence === 'weekly' && isCurrentExecutionGoal(data, goal, date)
}

/**
 * Retire only confidently identified automatic defaults. Evidence and handled
 * occurrence history stay intact; pending noise is removed and cannot regenerate.
 */
export function reconcileEvidenceReminderPolicy(data: AppData, date = todayLocal()): AppData {
  const normalizedGoals = data.goals.map(goal => ({
    ...goal,
    evidenceSchedules: goal.evidenceSchedules.map(schedule => ({
      ...schedule,
      provenance: inferredScheduleProvenance(goal, schedule),
    })),
  }))
  const normalized = { ...data, goals: normalizedGoals }
  const retiredScheduleIds = new Set<string>()
  const retiredTrackIds = new Set<string>()
  const goals = normalizedGoals.map(goal => {
    let evidenceSchedules = goal.evidenceSchedules.map(schedule => {
      if (schedule.provenance !== 'auto-default' || autoScheduleAllowed(normalized, goal, schedule, date)) return schedule
      retiredScheduleIds.add(schedule.id)
      retiredTrackIds.add(evidenceTrackKey({ goal, schedule }))
      return schedule.active ? { ...schedule, active: false } : schedule
    })
    const currentExecution = isCurrentExecutionGoal(normalized, goal, date)
    const hasReminderIntent = evidenceSchedules.some(schedule => schedule.active || schedule.provenance !== 'auto-default')
    const hasRetiredAutoCheckIn = evidenceSchedules.some(schedule => schedule.provenance === 'auto-default'
      && schedule.kind === 'note' && schedule.cadence === 'weekly')
    if (currentExecution && !hasReminderIntent && !hasRetiredAutoCheckIn) {
      evidenceSchedules = [...evidenceSchedules, {
        id: `${goal.id}-note-weekly`,
        kind: 'note',
        cadence: 'weekly',
        firstDueDate: date,
        active: true,
        provenance: 'auto-default',
      }]
    }
    return { ...goal, evidenceSchedules }
  })
  const reminderOccurrences = data.reminderOccurrences.filter(item =>
    !((retiredScheduleIds.has(item.scheduleId) || retiredTrackIds.has(item.trackId))
      && (item.status === 'due' || item.status === 'snoozed')))
  const unchangedGoals = goals.every((goal, goalIndex) => goal.evidenceSchedules.every((schedule, scheduleIndex) => {
    const prior = data.goals[goalIndex]?.evidenceSchedules[scheduleIndex]
    return prior && Object.keys(schedule).every(key => schedule[key as keyof EvidenceSchedule] === prior[key as keyof EvidenceSchedule])
  })) && goals.every((goal, index) => goal.evidenceSchedules.length === data.goals[index]?.evidenceSchedules.length)
  if (unchangedGoals && reminderOccurrences.length === data.reminderOccurrences.length) return data
  return { ...data, goals, reminderOccurrences }
}

function scheduleReferenceMatches(
  scheduled: ScheduledEvidence[],
  goal: Goal,
  schedule: EvidenceSchedule,
  entry: Evidence,
) {
  if (!entry.scheduleId || entry.scheduleId === schedule.id) return true
  const source = scheduled.find(item => item.schedule.id === entry.scheduleId)
  if (!source || source.schedule.kind === schedule.kind) return false
  return source.goal.id === goal.id
    || Boolean(source.schedule.historyId && schedule.historyId === source.schedule.historyId)
    || (evidenceGoalIds(entry).includes(source.goal.id) && evidenceGoalIds(entry).includes(goal.id))
}

function compareScheduledEvidence(left: ScheduledEvidence, right: ScheduledEvidence) {
  return left.goal.deadline.localeCompare(right.goal.deadline)
    || left.goal.createdAt.localeCompare(right.goal.createdAt)
    || left.goal.id.localeCompare(right.goal.id)
    || left.schedule.id.localeCompare(right.schedule.id)
}

function evidenceMatchesSchedule(goal: Goal, schedule: EvidenceSchedule, entry: Evidence) {
  if (schedule.kind === entry.kind) return true
  if (entry.mediaId && (schedule.kind === 'photo' || schedule.kind === 'screenshot')) return true
  return schedule.kind === 'note'
    && (goal.area === 'Business' || goal.kind === 'qualitative')
    && ['note', 'photo', 'screenshot', 'milestone'].includes(entry.kind)
}

export function dueEvidence(goals: Goal[], evidence: Evidence[], date = todayLocal(), occurrences: ReminderOccurrence[] = [], progress: ProgressEntry[] = [], wins: Win[] = []) {
  const scheduled = goals.flatMap(goal =>
    goal.evidenceSchedules
      .filter(schedule => schedule.active)
      .map(schedule => ({ goal, schedule })),
  )
  const tracks = new Map<string, { active: ScheduledEvidence[]; members: ScheduledEvidence[] }>()
  for (const item of scheduled) {
    const key = evidenceTrackKey(item)
    const track = tracks.get(key) ?? { active: [], members: [] }
    track.members.push(item)
    if (item.goal.status === 'active') track.active.push(item)
    tracks.set(key, track)
  }

  const due: DueEvidence[] = []
  const satisfiedDates = new Map([
    ...evidence.map(item => [item.id, recordedDateOf(item)] as const),
    ...progress.map(item => [item.id, recordedDateOf(item)] as const),
    ...wins.map(item => [item.id, recordedDateOf(item)] as const),
  ])
  for (const track of tracks.values()) {
    if (!track.active.length) continue
    const representative = [...track.active].sort(compareScheduledEvidence)[0]
    const trackId = evidenceTrackKey(representative)
    const captures = track.members.flatMap(({ goal, schedule }) => {
      const matching = evidence
        .filter(item =>
          evidenceMatchesSchedule(goal, schedule, item)
          && (Boolean(schedule.historyId && item.historyId === schedule.historyId) || evidenceGoalIds(item).includes(goal.id))
          && scheduleReferenceMatches(scheduled, goal, schedule, item),
        )
        .map(recordedDateOf)
      const measurements = schedule.kind === 'number'
        ? progress
          .filter(entry => schedule.historyId
            ? (entry.historyId ?? `measurement:${entry.goalId}`) === schedule.historyId
            : entry.goalId === goal.id)
          .map(recordedDateOf)
        : []
      const recordedWins = schedule.kind === 'note'
        ? wins.filter(entry => evidenceGoalIds(entry).includes(goal.id)).map(recordedDateOf)
        : []
      return schedule.lastCapturedAt
        ? [...matching, ...measurements, ...recordedWins, localDateOf(schedule.lastCapturedAt)]
        : [...matching, ...measurements, ...recordedWins]
    })
    const lastCaptured = captures.sort().at(-1)
    const lastHandled = occurrences
      .filter(item => item.trackId === trackId && (item.status === 'skipped' || item.status === 'satisfied'))
      .map(item => item.status === 'skipped'
        ? item.handledAt ? localDateOf(item.handledAt) : item.dueDate
        : item.satisfiedByEntryId ? satisfiedDates.get(item.satisfiedByEntryId) ?? item.dueDate : item.dueDate)
      .sort()
      .at(-1)
    const firstDue = track.active
      .map(({ goal, schedule }) => schedule.firstDueDate ?? localDateOf(goal.createdAt))
      .sort()[0]
    const lastActivity = [lastCaptured, lastHandled].filter((item): item is string => Boolean(item)).sort().at(-1)
    const dueDate = lastActivity
      ? nextEvidenceDate(lastActivity, representative.schedule.cadence)
      : firstDue
    const occurrenceId = `evidence:${trackId}:${dueDate}`
    const occurrence = occurrences.find(item => item.id === occurrenceId)
    const hiddenBySnooze = occurrence?.status === 'snoozed' && occurrence.snoozedUntil && occurrence.snoozedUntil > date
    if (dueDate <= date && !hiddenBySnooze) due.push({ ...representative, dueDate, trackId, occurrenceId })
  }

  const priority = (item: DueEvidence) => item.schedule.kind === 'number' && item.schedule.historyId ? 0
    : item.schedule.kind === 'note' && item.schedule.provenance === 'auto-default' ? 1
      : item.schedule.kind === 'photo' || item.schedule.kind === 'screenshot' ? 2 : 3
  return due.sort((left, right) =>
    left.dueDate.localeCompare(right.dueDate)
    || priority(left) - priority(right)
    || compareScheduledEvidence(left, right),
  )
}

/** The same track-level date shown by Today, including skipped/satisfied cadence and snooze state. */
export function nextEvidenceDueForSchedule(data: AppData, goalId: string, scheduleId: string) {
  const goal = data.goals.find(item => item.id === goalId)
  const schedule = goal?.evidenceSchedules.find(item => item.id === scheduleId)
  if (!goal || !schedule || !schedule.active) return undefined
  const trackId = evidenceTrackKey({ goal, schedule })
  const due = dueEvidence(data.goals, data.evidence, '9999-12-31', data.reminderOccurrences, data.progress, data.wins)
    .find(item => item.trackId === trackId)
  if (!due) return schedule.firstDueDate ?? localDateOf(goal.createdAt)
  const occurrence = data.reminderOccurrences.find(item => item.id === due.occurrenceId)
  return occurrence?.status === 'snoozed' && occurrence.snoozedUntil ? occurrence.snoozedUntil : due.dueDate
}

function cyclePeriod(kind: '3M' | '6M' | 'year', date: string, anchorMonth: string) {
  const length = kind === '3M' ? 3 : kind === '6M' ? 6 : 12
  const [year, month] = date.split('-').map(Number)
  const [anchorYear, anchorMonthNumber] = anchorMonth.split('-').map(Number)
  const difference = (year - anchorYear) * 12 + month - anchorMonthNumber
  const cycle = Math.floor(difference / length)
  const start = addMonths(startOfMonth(anchorMonth), cycle * length)
  return { start, end: addDays(addMonths(start, length), -1) }
}

export function periodFor(kind: PeriodRecord['kind'], date = todayLocal(), anchorMonth = startOfMonth(date), trackingStartedOn?: string): PeriodRecord {
  let start: string
  let end: string
  if (kind === 'week') {
    start = startOfWeek(date)
    end = endOfWeek(date)
  } else if (kind === 'month') {
    start = startOfMonth(date)
    end = endOfMonth(date)
  } else if (kind === '3M') {
    ;({ start, end } = cyclePeriod(kind, date, anchorMonth))
  } else if (kind === '6M') {
    ;({ start, end } = cyclePeriod(kind, date, anchorMonth))
  } else {
    ;({ start, end } = cyclePeriod(kind, date, anchorMonth))
  }
  const effectiveStart = trackingStartedOn && trackingStartedOn > start && trackingStartedOn <= end ? trackingStartedOn : undefined
  return { id: `${kind}:${start}`, kind, start, end, availableAt: addDays(end, 1), finalized: false, anchorMonth, effectiveStart }
}

function canonicalEvidenceDates(evidence: Evidence[]) {
  return evidenceCaptureGroups({ evidence }).map(group => recordedDateOf(group.canonical))
}

/** Empty auto-generated periods do not become recap spam. */
export function isRecapEligible(data: AppData, period: PeriodRecord, date = todayLocal()) {
  if (period.availableAt > date || period.end >= date || period.end < data.planning.trackingStartedOn) return false
  const periodStart = [period.effectiveStart ?? period.start, data.planning.trackingStartedOn].sort().at(-1)!
  const meaningfulTask = data.tasks.some(task =>
    (task.done || (task.status !== 'excluded' && task.status !== 'deleted')) && task.dueDate >= periodStart && task.dueDate <= period.end && (task.kind !== 'routine' || task.done),
  )
  const progress = data.progress.some(item => recordedDateOf(item) >= periodStart && recordedDateOf(item) <= period.end)
  const evidence = canonicalEvidenceDates(data.evidence).some(item => item >= periodStart && item <= period.end)
  const win = data.wins.some(item => recordedDateOf(item) >= periodStart && recordedDateOf(item) <= period.end)
  const lifecycle = data.goals.some(goal => goal.history.some(item =>
    item.action !== 'created' && localDateOf(item.at) >= periodStart && localDateOf(item.at) <= period.end,
  ))
  return meaningfulTask || progress || evidence || win || lifecycle
}

function activityDates(data: AppData) {
  return [
    ...data.tasks.map(item => item.dueDate),
    ...data.progress.map(recordedDateOf),
    ...canonicalEvidenceDates(data.evidence),
    ...data.wins.map(recordedDateOf),
    ...data.goals.flatMap(goal => goal.history.map(item => localDateOf(item.at))),
  ].filter(Boolean)
}

function reconcilePeriods(data: AppData, date: string) {
  const kinds = ['week', 'month', '3M', '6M', 'year'] as const
  const periods = [...data.periods]
  const dates = activityDates(data).filter(activityDate => activityDate >= data.planning.trackingStartedOn)
  for (const kind of kinds) {
    const current = periodFor(kind, date, data.planning.anchorMonth, data.planning.trackingStartedOn)
    const previous = periodFor(kind, addDays(current.start, -1), data.planning.anchorMonth, data.planning.trackingStartedOn)
    for (const anchor of [date, previous.start, ...dates]) {
      if (anchor > date) continue
      const period = periodFor(kind, anchor, data.planning.anchorMonth, data.planning.trackingStartedOn)
      if (period.end < data.planning.trackingStartedOn) continue
      if (!periods.some(existing => existing.id === period.id)) periods.push(period)
    }
  }
  return periods.sort((a, b) => a.start.localeCompare(b.start) || a.kind.localeCompare(b.kind))
}

export function reconcileSchedule(data: AppData, date = todayLocal()) {
  const newTasks = generateRoutineTasks(data.routines, data.tasks, date, data.routineExclusions)
  const tasks = [...data.tasks, ...newTasks]
  const scheduledData = { ...data, tasks }
  const periods = reconcilePeriods(scheduledData, date)
  const reminders: Reminder[] = []
  let reminderOccurrences = [...data.reminderOccurrences]

  if (data.settings.reminders.evidence) {
    for (const item of dueEvidence(data.goals, data.evidence, date, reminderOccurrences, data.progress, data.wins)) {
      const existing = reminderOccurrences.find(occurrence => occurrence.id === item.occurrenceId)
      if (!existing) reminderOccurrences.push({ id: item.occurrenceId, trackId: item.trackId, scheduleId: item.schedule.id, dueDate: item.dueDate, status: 'due' })
      else if (existing.status === 'snoozed' && existing.snoozedUntil && existing.snoozedUntil <= date) reminderOccurrences = reminderOccurrences.map(occurrence => occurrence.id === existing.id ? { ...occurrence, status: 'due', snoozedUntil: undefined } : occurrence)
      reminders.push({
        id: item.occurrenceId,
        kind: 'evidence',
        title: `${item.schedule.cadence[0].toUpperCase() + item.schedule.cadence.slice(1)} ${item.schedule.kind} due`,
        detail: item.goal.title,
        dueDate: item.dueDate,
        action: 'capture',
      })
    }
  }
  if (data.settings.reminders.recap) {
    for (const period of periods.filter(period => !period.finalized && isRecapEligible(scheduledData, period, date))) {
      reminders.push({
        id: `recap:${period.id}`,
        kind: 'recap',
        title: `${period.kind === '3M' ? '3-month' : period.kind === '6M' ? '6-month' : period.kind} recap ready`,
        dueDate: period.availableAt,
        action: 'recap',
      })
    }
  }
  if (data.settings.reminders.deadline) {
    for (const goal of data.goals.filter(goal => isDeadlineReviewDue(goal, date))) {
      reminders.push({
        id: `deadline:${goal.id}`,
        kind: 'deadline',
        title: 'Goal review required',
        detail: goal.title,
        dueDate: goal.deadline,
        action: 'deadline-review',
      })
    }
  }
  const monthStart = startOfMonth(date)
  const firstWeekOfMonth = date <= addDays(monthStart, 6)
  const hasPlannedMove = tasks.some(task => task.kind === 'move' && task.dueDate >= monthStart && task.dueDate <= date)
  if (firstWeekOfMonth && !hasPlannedMove) {
    const label = new Intl.DateTimeFormat('en-US', { month: 'long' }).format(dateAtLocalMidnight(date))
    reminders.push({
      id: `planning:${monthStart}`,
      kind: 'planning',
      title: `${label} planning is ready`,
      detail: 'Review your horizons and choose a Goal Move.',
      dueDate: monthStart,
      action: 'goals',
    })
  }
  const rollover = rolloverCandidates(tasks, date)
  if (rollover.length) {
    reminders.push({
      id: `rollover:${date}`,
      kind: 'rollover',
      title: `${rollover.length} unfinished ${rollover.length === 1 ? 'item needs' : 'items need'} a decision`,
      dueDate: date,
      action: 'rollover',
    })
  }
  if (data.settings.reminders.morning) {
    reminders.push({
      id: `morning:${date}`,
      kind: 'morning',
      title: 'Your day is ready',
      detail: 'Choose your Moves That Matter.',
      dueDate: date,
      action: 'today',
    })
  }

  return { tasks, periods, reminderOccurrences, reminders, generated: newTasks.length }
}

export function snoozeReminderOccurrence(occurrences: ReminderOccurrence[], id: string, until: string) {
  return occurrences.map(item => item.id === id && (item.status === 'due' || item.status === 'snoozed') ? { ...item, status: 'snoozed' as const, snoozedUntil: until } : item)
}

export function skipReminderOccurrence(occurrences: ReminderOccurrence[], id: string, at = now()) {
  return occurrences.map(item => item.id === id && (item.status === 'due' || item.status === 'snoozed') ? { ...item, status: 'skipped' as const, snoozedUntil: undefined, handledAt: at } : item)
}

function withCurrentDueOccurrences(data: AppData, date: string) {
  const occurrences = [...data.reminderOccurrences]
  for (const item of dueEvidence(data.goals, data.evidence, date, occurrences, data.progress, data.wins)) {
    if (!occurrences.some(occurrence => occurrence.id === item.occurrenceId)) {
      occurrences.push({ id: item.occurrenceId, trackId: item.trackId, scheduleId: item.schedule.id, dueDate: item.dueDate, status: 'due' })
    }
  }
  return occurrences
}

export function snoozeReminderInData(data: AppData, id: string, until: string, date = todayLocal()): AppData {
  return { ...data, reminderOccurrences: snoozeReminderOccurrence(withCurrentDueOccurrences(data, date), id, until) }
}

export function skipReminderInData(data: AppData, id: string, date = todayLocal(), at = now()): AppData {
  return { ...data, reminderOccurrences: skipReminderOccurrence(withCurrentDueOccurrences(data, date), id, at) }
}

export function satisfyReminderOccurrences(data: AppData, entry: Evidence) {
  const date = recordedDateOf(entry)
  const ids = evidenceGoalIds(entry)
  const prior = { ...data, evidence: data.evidence.filter(item => item.id !== entry.id) }
  return withCurrentDueOccurrences(prior, date).map(occurrence => {
    if (occurrence.status !== 'due' && occurrence.status !== 'snoozed') return occurrence
    if (occurrence.dueDate > date) return occurrence
    const schedule = data.goals.flatMap(goal => goal.evidenceSchedules.map(item => ({ goal, schedule: item }))).find(item => item.schedule.id === occurrence.scheduleId)
    if (!schedule) return occurrence
    const kindCompatible = evidenceMatchesSchedule(schedule.goal, schedule.schedule, entry)
    if (!kindCompatible) return occurrence
    const scheduled = data.goals.flatMap(candidate => candidate.evidenceSchedules.map(item => ({ goal: candidate, schedule: item })))
    const compatible = (entry.scheduleId === occurrence.scheduleId
      || Boolean(entry.historyId && schedule.schedule.historyId === entry.historyId)
      || ids.includes(schedule.goal.id))
      && scheduleReferenceMatches(scheduled, schedule.goal, schedule.schedule, entry)
    return compatible ? { ...occurrence, status: 'satisfied' as const, snoozedUntil: undefined, handledAt: entry.capturedAt, satisfiedByEntryId: entry.id } : occurrence
  })
}

/**
 * Replace an evidence record without leaving its former reminder track marked
 * satisfied. The edited record is then applied to the occurrence(s) that match
 * its new date and relationships.
 */
export function updateEvidenceInData(data: AppData, entry: Evidence): AppData {
  if (!data.evidence.some(item => item.id === entry.id)) return data
  const goalIds = evidenceGoalIds(entry).filter(id => data.goals.some(goal => goal.id === id))
  const relatedGoals = data.goals.filter(goal => goalIds.includes(goal.id))
  const primaryGoal = relatedGoals[0]
  const observation = entry.observationId
    ? data.progress.find(item => item.id === entry.observationId)
    : undefined
  const observationHistoryId = observation
    ? observation.historyId ?? data.goals.find(goal => goal.id === observation.goalId)?.measurementHistoryId
    : undefined
  const retainedHistoryId = entry.historyId && (
    goalIds.length === 0
    || relatedGoals.some(goal => goal.measurementHistoryId === entry.historyId
      || goal.evidenceSchedules.some(schedule => schedule.historyId === entry.historyId))
  ) ? entry.historyId : undefined
  const historyId = observationHistoryId ?? retainedHistoryId ?? primaryGoal?.measurementHistoryId
  const referencedSchedule = entry.scheduleId
    ? data.goals.flatMap(goal => goal.evidenceSchedules.map(schedule => ({ goal, schedule })))
      .find(item => item.schedule.id === entry.scheduleId)
    : undefined
  const scheduleId = referencedSchedule && (
    goalIds.includes(referencedSchedule.goal.id)
    || Boolean(historyId && referencedSchedule.schedule.historyId === historyId)
  ) ? referencedSchedule.schedule.id : undefined
  const normalized: Evidence = {
    ...entry,
    goalId: goalIds[0],
    goalIds,
    historyId,
    scheduleId,
    recordedOn: entry.recordedOn ?? localDateOf(entry.capturedAt),
  }
  const next: AppData = {
    ...data,
    evidence: data.evidence.map(item => item.id === normalized.id ? normalized : item),
    reminderOccurrences: data.reminderOccurrences.map(item => item.satisfiedByEntryId === normalized.id
      ? { ...item, status: 'due', satisfiedByEntryId: undefined, handledAt: undefined, snoozedUntil: undefined }
      : item),
  }
  return { ...next, reminderOccurrences: satisfyReminderOccurrences(next, normalized) }
}

export function satisfyWinReminderOccurrences(data: AppData, entry: Win) {
  const date = recordedDateOf(entry)
  const ids = evidenceGoalIds(entry)
  const prior = { ...data, wins: data.wins.filter(item => item.id !== entry.id) }
  return withCurrentDueOccurrences(prior, date).map(occurrence => {
    if (occurrence.status !== 'due' && occurrence.status !== 'snoozed') return occurrence
    if (occurrence.dueDate > date) return occurrence
    const scheduled = data.goals.flatMap(goal => goal.evidenceSchedules.map(schedule => ({ goal, schedule }))).find(item => item.schedule.id === occurrence.scheduleId)
    if (!scheduled || scheduled.schedule.kind !== 'note' || !ids.includes(scheduled.goal.id)) return occurrence
    return { ...occurrence, status: 'satisfied' as const, snoozedUntil: undefined, handledAt: entry.createdAt, satisfiedByEntryId: entry.id }
  })
}

export function satisfyProgressReminderOccurrences(data: AppData, entry: ProgressEntry) {
  const date = recordedDateOf(entry)
  const historyId = entry.historyId ?? data.goals.find(goal => goal.id === entry.goalId)?.measurementHistoryId ?? `measurement:${entry.goalId}`
  const prior = { ...data, progress: data.progress.filter(item => item.id !== entry.id) }
  return withCurrentDueOccurrences(prior, date).map(occurrence => {
    if (occurrence.status !== 'due' && occurrence.status !== 'snoozed') return occurrence
    if (occurrence.dueDate > date) return occurrence
    const scheduled = data.goals.flatMap(goal => goal.evidenceSchedules.map(schedule => ({ goal, schedule }))).find(item => item.schedule.id === occurrence.scheduleId)
    if (!scheduled || scheduled.schedule.kind !== 'number') return occurrence
    const compatible = scheduled.schedule.historyId === historyId || scheduled.goal.id === entry.goalId
    return compatible ? { ...occurrence, status: 'satisfied' as const, snoozedUntil: undefined, handledAt: entry.recordedAt, satisfiedByEntryId: entry.id } : occurrence
  })
}
