import type { AppData, EvidenceSchedule, Goal, GoalDirection, GoalKind, Horizon, MeasurementHistory, ProgressEntry } from './domain'
import { compareProgressEntries, localDateOf, now, timestampForLocalDate, todayLocal } from './domain'

export type DeadlineReason =
  | 'did-not-execute'
  | 'unrealistic'
  | 'priorities-changed'
  | 'blocked'
  | 'no-longer-important'
  | 'other'

const months: Record<Horizon, number> = { '1M': 1, '3M': 3, '6M': 6, '1Y': 12, '2Y': 24 }

function finite(value: number | undefined) {
  return value === undefined || Number.isFinite(value)
}

function inferredDirection(baseline?: number, target?: number): GoalDirection | undefined {
  if (baseline === undefined || target === undefined || baseline === target) return undefined
  return target > baseline ? 'increase' : 'decrease'
}

export const planningAnchorFor = (from: Date | string = new Date()) => {
  const date = typeof from === 'string'
    ? /^\d{4}-\d{2}-\d{2}$/.test(from) ? new Date(`${from}T12:00:00`) : new Date(from)
    : new Date(from)
  date.setDate(1)
  return todayLocal(date)
}

/** Calendar-aligned deadline measured from the first of the starting month. */
export function deadlineFor(horizon: Horizon, from = new Date()) {
  const result = new Date(from)
  result.setDate(1)
  result.setMonth(result.getMonth() + months[horizon])
  return todayLocal(result)
}

export function legacyDeadlineFor(horizon: Horizon, from: Date) {
  const result = new Date(from)
  const originalDay = result.getDate()
  result.setDate(1)
  result.setMonth(result.getMonth() + months[horizon])
  const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate()
  result.setDate(Math.min(originalDay, lastDay))
  return todayLocal(result)
}

export function createGoal(input: {
  title: string
  horizon: Horizon
  kind?: GoalKind
  area?: string
  baseline?: number
  target?: number
  direction?: GoalDirection
  unit?: string
  deadline?: string
  createdAt?: string
  color?: string
}): Goal {
  const title = input.title.trim()
  if (!title) throw new Error('A goal needs a title.')
  if (!finite(input.baseline) || !finite(input.target)) throw new Error('Goal values must be finite numbers.')

  const createdAt = input.createdAt ?? now()
  const from = input.createdAt ? new Date(input.createdAt) : new Date()
  const deadline = input.deadline ?? deadlineFor(input.horizon, from)
  const kind = input.kind ?? (input.baseline !== undefined || input.target !== undefined ? 'numeric' : 'qualitative')
  const direction = input.direction ?? inferredDirection(input.baseline, input.target)

  return {
    id: crypto.randomUUID(),
    title,
    horizon: input.horizon,
    kind,
    area: input.area,
    baseline: input.baseline,
    current: input.baseline,
    target: input.target,
    direction,
    unit: input.unit,
    deadline,
    deadlineAnchor: planningAnchorFor(from),
    deadlineProvenance: input.deadline ? 'manual' : 'calendar-default',
    status: 'active',
    color: input.color ?? 'sky',
    milestones: [],
    links: [],
    history: [{ at: createdAt, action: 'created', current: input.baseline, target: input.target, deadline }],
    evidenceSchedules: [],
    createdAt,
  }
}

export function progressHistoryId(goal: Pick<Goal, 'id' | 'measurementHistoryId'>) {
  return goal.measurementHistoryId ?? `measurement:${goal.id}`
}

/** Deliberately narrow semantics: these labels aid setup, but never merge histories. */
export function measurementSemanticForGoal(goal: Pick<Goal, 'kind' | 'title' | 'unit'>) {
  if (goal.kind !== 'numeric') return undefined
  const title = goal.title.trim()
  const unit = goal.unit?.trim()
  if (unit?.toLowerCase() === 'lbs' && /(?:lbs?|weight)/i.test(title)) {
    return { semanticKey: 'body-weight' as const, label: 'Weight' }
  }
  if (unit?.toUpperCase() === 'USD' && /(?:stacked|savings?)/i.test(title)) {
    return { semanticKey: 'savings-balance' as const, label: 'Savings' }
  }
  return undefined
}

export function defaultEvidenceSchedulesForGoal(goal: Goal, historyId = goal.measurementHistoryId, historySemanticKey?: MeasurementHistory['semanticKey']): EvidenceSchedule[] {
  const semanticKey = historySemanticKey ?? measurementSemanticForGoal(goal)?.semanticKey
  const firstDueDate = localDateOf(goal.createdAt)
  if (semanticKey === 'body-weight') {
    return [
      { id: `${goal.id}-number-weekly`, kind: 'number', cadence: 'weekly', historyId, firstDueDate, active: true },
      { id: `${goal.id}-photo-monthly`, kind: 'photo', cadence: 'monthly', historyId, firstDueDate, active: true },
    ]
  }
  if (semanticKey === 'savings-balance') {
    return [
      { id: `${goal.id}-number-weekly`, kind: 'number', cadence: 'weekly', historyId, firstDueDate, active: true },
      // Keep the useful screenshot option visible without creating another prompt by default.
      { id: `${goal.id}-screenshot-monthly`, kind: 'screenshot', cadence: 'monthly', historyId, firstDueDate, active: false },
    ]
  }
  if (goal.kind === 'numeric') {
    return [{ id: `${goal.id}-number-weekly`, kind: 'number', cadence: 'weekly', historyId, firstDueDate, active: true }]
  }
  if (goal.area === 'Business' || goal.kind === 'qualitative') {
    return [{ id: `${goal.id}-note-weekly`, kind: 'note', cadence: 'weekly', firstDueDate, active: true }]
  }
  return []
}

/**
 * Inserts a goal with an explicit measurement history and editable capture defaults.
 * A supplied history is honored only when it is a live history in this snapshot.
 */
export function addGoalToData(data: AppData, input: Goal): AppData {
  if (data.goals.some(goal => goal.id === input.id)) return data
  if (input.kind !== 'numeric') {
    const goal = { ...input, measurementHistoryId: undefined }
    return { ...data, goals: [...data.goals, { ...goal, evidenceSchedules: goal.evidenceSchedules.length ? goal.evidenceSchedules : defaultEvidenceSchedulesForGoal(goal) }] }
  }

  const suppliedHistory = input.measurementHistoryId
    ? data.measurementHistories.find(history => history.id === input.measurementHistoryId && !history.mergedIntoId)
    : undefined
  const historyId = suppliedHistory?.id ?? `measurement:${input.id}`
  const semantic = measurementSemanticForGoal(input)
  const newHistory: MeasurementHistory | undefined = suppliedHistory ? undefined : {
    id: historyId,
    label: semantic?.label ?? input.title,
    unit: input.unit,
    semanticKey: semantic?.semanticKey,
    createdAt: input.createdAt,
  }
  const latest = data.progress
    .filter(entry => (entry.historyId ?? `measurement:${entry.goalId}`) === historyId)
    .sort(compareProgressEntries)
    .at(-1)
  const baseGoal = {
    ...input,
    measurementHistoryId: historyId,
    baseline: input.baseline ?? latest?.value,
    current: latest?.value ?? input.current,
  }
  const evidenceSchedules = baseGoal.evidenceSchedules.length
    ? baseGoal.evidenceSchedules.map(schedule => ({ ...schedule, historyId: schedule.historyId ?? historyId }))
    : defaultEvidenceSchedulesForGoal(baseGoal, historyId, suppliedHistory?.semanticKey)
  return {
    ...data,
    goals: [...data.goals, { ...baseGoal, evidenceSchedules }],
    measurementHistories: newHistory ? [...data.measurementHistories, newHistory] : data.measurementHistories,
  }
}

export function currentValueFor(goal: Goal, progress: ProgressEntry[]) {
  const historyId = progressHistoryId(goal)
  return progress
    .filter(entry => (entry.historyId ?? `measurement:${entry.goalId}`) === historyId)
    .sort(compareProgressEntries)
    .at(-1)?.value ?? goal.current
}

/** Insert one observation and derive linked-goal state from local record chronology. */
export function recordProgressInData(data: AppData, entry: ProgressEntry): AppData {
  if (data.progress.some(item => item.id === entry.id)) return data
  const origin = data.goals.find(goal => goal.id === entry.goalId)
  if (!origin) return data
  const historyId = entry.historyId ?? progressHistoryId(origin)
  const observation = { ...entry, historyId, recordedOn: entry.recordedOn ?? localDateOf(entry.recordedAt) }
  const progress = [...data.progress, observation]
  const ordered = progress
    .filter(item => (item.historyId ?? `measurement:${item.goalId}`) === historyId)
    .sort(compareProgressEntries)
  const earliest = ordered[0]
  const latest = ordered.at(-1)!
  return {
    ...data,
    progress,
    goals: data.goals.map(goal => {
      if (progressHistoryId(goal) !== historyId) return goal
      const candidate = { ...goal, baseline: goal.baseline ?? earliest.value, current: latest.value }
      return latest.id === observation.id && goal.status === 'active' && numericTargetReached(candidate)
        ? completeGoal(candidate, timestampForLocalDate(observation.recordedOn, entry.recordedAt), 'Target reached by shared measurement')
        : candidate
    }),
  }
}

export function addGoalContextNote(goal: Goal, value: string): Goal {
  const note = value.trim().slice(0, 800)
  if (!note) return goal
  const existing = goal.contextNotes ?? []
  if (existing.some(item => item.toLocaleLowerCase() === note.toLocaleLowerCase())) return goal
  return { ...goal, contextNotes: [...existing.slice(-19), note] }
}

export function deadlineCorrectionPreview(data: AppData) {
  return data.goals.flatMap(goal => {
    if (goal.deadlineProvenance !== 'legacy-unknown' || goal.status === 'completed' || goal.status === 'closed') return []
    const created = new Date(goal.createdAt)
    if (goal.deadline !== legacyDeadlineFor(goal.horizon, created)) return []
    const goalAnchor = goal.deadlineAnchor ?? planningAnchorFor(created)
    const proposed = deadlineFor(goal.horizon, new Date(`${goalAnchor.slice(0, 10)}T12:00:00`))
    return proposed === goal.deadline ? [] : [{ goalId: goal.id, title: goal.title, from: goal.deadline, to: proposed }]
  })
}

export function confirmDeadlineCorrections(data: AppData, goalIds: string[], at = now()): AppData {
  const approved = new Map(deadlineCorrectionPreview(data).filter(item => goalIds.includes(item.goalId)).map(item => [item.goalId, item]))
  if (!approved.size) return data
  return {
    ...data,
    goals: data.goals.map(goal => {
      const correction = approved.get(goal.id)
      if (!correction) return goal
      return {
        ...goal,
        deadline: correction.to,
        deadlineAnchor: goal.deadlineAnchor ?? planningAnchorFor(goal.createdAt),
        deadlineProvenance: 'calendar-default',
        history: [...goal.history, { at, action: 'adjusted', note: `Calendar-aligned deadline confirmed; previous deadline ${correction.from}`, current: goal.current, target: goal.target, deadline: correction.to }],
      }
    }),
  }
}

export function numericTargetReached(goal: Goal) {
  if (goal.kind !== 'numeric' || goal.current === undefined || goal.target === undefined) return false
  if (goal.current === goal.target) return true
  const direction = goal.direction ?? inferredDirection(goal.baseline, goal.target)
  if (!direction) return false
  return direction === 'increase' ? goal.current >= goal.target : goal.current <= goal.target
}

export function isGoalComplete(goal: Goal) {
  return goal.status === 'completed'
}

export function updateNumeric(goal: Goal, value: number, at = now()): Goal {
  if (!Number.isFinite(value)) throw new Error('Progress must be a finite number.')
  const baseline = goal.baseline ?? value
  const direction = goal.direction ?? inferredDirection(baseline, goal.target)
  const candidate = { ...goal, baseline, current: value, direction }
  const newlyCompleted = goal.status !== 'completed' && goal.status !== 'closed' && numericTargetReached(candidate)
  return {
    ...candidate,
    status: newlyCompleted ? 'completed' : goal.status,
    history: [
      ...goal.history,
      {
        at,
        action: newlyCompleted ? 'completed' : 'progressed',
        current: value,
        target: goal.target,
        deadline: goal.deadline,
      },
    ],
  }
}

export function completeGoal(goal: Goal, at = now(), note?: string): Goal {
  if (goal.status === 'completed') return goal
  return {
    ...goal,
    status: 'completed',
    history: [...goal.history, { at, action: 'completed', note, current: goal.current, target: goal.target, deadline: goal.deadline }],
  }
}

export function pauseGoal(goal: Goal, at = now(), note?: string): Goal {
  if (goal.status !== 'active') return goal
  return {
    ...goal,
    status: 'paused',
    history: [...goal.history, { at, action: 'paused', note, current: goal.current, target: goal.target, deadline: goal.deadline }],
  }
}

export function resumeGoal(goal: Goal, at = now(), note?: string): Goal {
  if (goal.status !== 'paused') return goal
  return {
    ...goal,
    status: 'active',
    history: [...goal.history, { at, action: 'resumed', note, current: goal.current, target: goal.target, deadline: goal.deadline }],
  }
}

/** Restore a completed goal for an intentional correction without erasing its attempt. */
export function reopenGoal(goal: Goal, at = now(), note = 'Reopened completed goal'): Goal {
  if (goal.status !== 'completed') return goal
  return {
    ...goal,
    status: 'active',
    history: [...goal.history, { at, action: 'reopened', note, current: goal.current, target: goal.target, deadline: goal.deadline }],
  }
}

export function editGoalDetails(goal: Goal, changes: { title: string; nextAction?: string }, at = now()): Goal {
  const title = changes.title.trim()
  if (!title) throw new Error('A goal needs a title.')
  const nextAction = changes.nextAction?.trim() || undefined
  if (title === goal.title && nextAction === goal.nextAction) return goal
  const changed = [title !== goal.title ? `Renamed from “${goal.title}”` : undefined, nextAction !== goal.nextAction ? 'next action updated' : undefined].filter(Boolean).join('; ')
  return {
    ...goal,
    title,
    nextAction,
    history: [...goal.history, { at, action: 'adjusted', note: changed, current: goal.current, target: goal.target, deadline: goal.deadline }],
  }
}

export function setMilestoneDone(goal: Goal, milestoneId: string, done: boolean, at = now()): Goal {
  const existing = goal.milestones.find(m => m.id === milestoneId)
  if (!existing || existing.done === done) return goal
  const milestones = goal.milestones.map(m =>
    m.id === milestoneId ? { ...m, done, completedAt: done ? at : undefined } : m,
  )
  const newlyCompleted = goal.kind === 'milestone'
    && goal.status !== 'completed'
    && goal.status !== 'closed'
    && milestones.length > 0
    && milestones.every(m => m.done)
  return {
    ...goal,
    milestones,
    status: newlyCompleted ? 'completed' : goal.status,
    history: [
      ...goal.history,
      {
        at,
        action: newlyCompleted ? 'completed' : 'milestone',
        note: `${done ? 'Completed' : 'Reopened'} milestone: ${existing.title}`,
        current: goal.current,
        target: goal.target,
        deadline: goal.deadline,
      },
    ],
  }
}

export function reviewDeadline(
  goal: Goal,
  action: 'continue' | 'adjust' | 'close',
  reason: DeadlineReason,
  options: { deadline?: string; target?: number; note?: string; at?: string } = {},
): Goal {
  if (!finite(options.target)) throw new Error('Goal target must be a finite number.')
  const at = options.at ?? now()
  const note = [reason, options.note].filter(Boolean).join(': ')
  if (action === 'close') {
    return {
      ...goal,
      status: 'closed',
      history: [...goal.history, { at, action: 'closed', note, current: goal.current, target: goal.target, deadline: goal.deadline }],
    }
  }

  const deadline = options.deadline ?? deadlineFor(goal.horizon, new Date(at))
  const deadlineIsReal = /^\d{4}-\d{2}-\d{2}$/.test(deadline)
    && localDateOf(new Date(`${deadline}T12:00:00`)) === deadline
  if (!deadlineIsReal || deadline <= localDateOf(at)) {
    throw new Error('Continued goals need a real deadline after the review date.')
  }
  const target = action === 'adjust' ? options.target ?? goal.target : goal.target
  const direction = action === 'adjust' && options.target !== undefined
    ? inferredDirection(goal.baseline, target) ?? goal.direction
    : goal.direction
  return {
    ...goal,
    status: 'active',
    target,
    direction,
    deadline,
    deadlineAnchor: planningAnchorFor(at),
    deadlineProvenance: options.deadline ? 'manual' : 'calendar-default',
    history: [
      ...goal.history,
      {
        at,
        action: action === 'adjust' ? 'adjusted' : 'continued',
        note,
        current: goal.current,
        target,
        deadline,
      },
    ],
  }
}

export const isDeadlineReviewDue = (goal: Goal, date = todayLocal()) =>
  goal.status === 'active' && goal.deadline <= date && !isGoalComplete(goal)
