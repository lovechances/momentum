import type { AppData, Evidence, Goal, PeriodRecord, ProgressEntry, Routine, Settings, Task, Win } from './domain'
import { createInitialData, seededGoals, seededRoutines } from './seed'
import { deadlineFor } from './goals'
import { now, todayLocal } from './domain'

const statuses = new Set(['active', 'paused', 'completed', 'closed'])
const kinds = new Set(['numeric', 'binary', 'milestone', 'consistency', 'qualitative'])
const horizons = new Set(['1M', '3M', '6M', '1Y', '2Y'])
const sections = new Set(['Morning', 'Moves That Matter', 'Day', 'Evening'])
const taskKinds = new Set(['task', 'routine', 'move'])
const taskStatuses = new Set(['active', 'rolled', 'dropped'])
const historyActions = new Set(['created', 'continued', 'adjusted', 'closed', 'completed', 'progressed', 'paused', 'resumed', 'reopened', 'milestone'])
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const isTimestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
const isDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}
const unique = <T extends { id: string }>(values: T[]) => values.filter((value, index) => values.findIndex(item => item.id === value.id) === index)

function normalizeGoal(value: Partial<Goal>, fallback: Goal): Goal {
  const baseline = typeof value.baseline === 'number' && Number.isFinite(value.baseline) ? value.baseline : undefined
  const current = typeof value.current === 'number' && Number.isFinite(value.current) ? value.current : undefined
  const target = typeof value.target === 'number' && Number.isFinite(value.target) ? value.target : undefined
  const hasProgress = current !== undefined || baseline !== undefined
  // The original visual scaffold persisted four invented values under g1…g19
  // with an empty history. Canonicalize those seed records without carrying the
  // fabricated 137 lb / 80% / $5,800 story forward.
  const wasScaffoldValue = /^g(?:[1-9]|1\d)$/.test(value.id || '')
    && fallback.title === value.title
    && (!Array.isArray(value.history) || value.history.length === 0)
  const createdAt = isTimestamp(value.createdAt) ? value.createdAt : fallback.createdAt
  const history = Array.isArray(value.history)
    ? value.history.filter(item => isRecord(item) && isTimestamp(item.at) && historyActions.has(String(item.action))).map(item => ({
      at: item.at as string,
      action: item.action as Goal['history'][number]['action'],
      note: typeof item.note === 'string' ? item.note : undefined,
      current: typeof item.current === 'number' && Number.isFinite(item.current) ? item.current : undefined,
      target: typeof item.target === 'number' && Number.isFinite(item.target) ? item.target : undefined,
      deadline: isDate(item.deadline) ? item.deadline : undefined,
    }))
    : []
  return {
    ...fallback,
    ...value,
    baseline: wasScaffoldValue ? undefined : baseline,
    current: wasScaffoldValue ? undefined : current,
    target: wasScaffoldValue ? fallback.target : target,
    unit: wasScaffoldValue ? fallback.unit : typeof value.unit === 'string' ? value.unit : undefined,
    direction: value.direction === 'increase' || value.direction === 'decrease' ? value.direction : fallback.direction,
    kind: wasScaffoldValue ? fallback.kind : kinds.has(String(value.kind)) ? value.kind! : fallback.kind,
    status: statuses.has(String(value.status)) ? value.status! : fallback.status,
    horizon: horizons.has(String(value.horizon)) ? value.horizon! : fallback.horizon,
    deadline: isDate(value.deadline) ? value.deadline : deadlineFor(horizons.has(String(value.horizon)) ? value.horizon! : fallback.horizon),
    area: typeof value.area === 'string' ? value.area : fallback.area,
    color: typeof value.color === 'string' ? value.color : fallback.color,
    nextAction: typeof value.nextAction === 'string' ? value.nextAction : undefined,
    milestones: Array.isArray(value.milestones) ? unique(value.milestones.filter(item => isRecord(item) && typeof item.id === 'string' && Boolean(item.id) && typeof item.title === 'string' && Boolean(item.title) && typeof item.done === 'boolean').map(item => ({ id: item.id as string, title: item.title as string, done: item.done as boolean, completedAt: isTimestamp(item.completedAt) ? item.completedAt : undefined }))) : [],
    links: Array.isArray(value.links) ? value.links.filter((item): item is string => typeof item === 'string') : [],
    // Status can be preserved from an older snapshot, but without a historical
    // event we do not know when completion happened and must not date it here.
    history: history.length ? history : [{ at: createdAt, action: 'created', current: wasScaffoldValue ? undefined : hasProgress ? current : undefined, target: wasScaffoldValue ? fallback.target : target, deadline: isDate(value.deadline) ? value.deadline : fallback.deadline }],
    evidenceSchedules: Array.isArray(value.evidenceSchedules) ? unique(value.evidenceSchedules.filter(item => isRecord(item) && typeof item.id === 'string' && Boolean(item.id) && ['photo', 'screenshot', 'number', 'milestone'].includes(String(item.kind)) && ['weekly', 'monthly', 'quarterly'].includes(String(item.cadence)) && typeof item.active === 'boolean').map(item => ({ id: item.id as string, kind: item.kind as Goal['evidenceSchedules'][number]['kind'], cadence: item.cadence as Goal['evidenceSchedules'][number]['cadence'], lastCapturedAt: isTimestamp(item.lastCapturedAt) ? item.lastCapturedAt : undefined, firstDueDate: isDate(item.firstDueDate) ? item.firstDueDate : undefined, active: item.active as boolean }))) : fallback.evidenceSchedules,
    createdAt,
  }
}

function normalizeTask(value: Partial<Task>): Task | undefined {
  if (typeof value.id !== 'string' || !value.id || typeof value.title !== 'string' || !value.title) return undefined
  return {
    id: value.id, title: value.title, section: sections.has(String(value.section)) ? value.section! : 'Day', done: Boolean(value.done),
    kind: taskKinds.has(String(value.kind)) ? value.kind! : 'task', goalId: typeof value.goalId === 'string' ? value.goalId : undefined, dueDate: isDate(value.dueDate) ? value.dueDate : todayLocal(),
    sourceRoutineId: typeof value.sourceRoutineId === 'string' ? value.sourceRoutineId : undefined, createdAt: isTimestamp(value.createdAt) ? value.createdAt : now(), carriedCount: Number.isInteger(value.carriedCount) && value.carriedCount! >= 0 ? value.carriedCount! : 0,
    lightDay: typeof value.lightDay === 'boolean' ? value.lightDay : undefined,
    status: taskStatuses.has(String(value.status)) ? value.status : 'active',
    resolvedAt: isTimestamp(value.resolvedAt) ? value.resolvedAt : undefined,
    rolledToId: typeof value.rolledToId === 'string' ? value.rolledToId : undefined,
  }
}

function normalizeRoutine(value: unknown): Routine | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || typeof value.title !== 'string' || !value.title) return undefined
  const recurrence = isRecord(value.recurrence) ? value.recurrence : {}
  const type = ['daily', 'weekdays', 'weekdays-custom'].includes(String(recurrence.type)) ? recurrence.type as Routine['recurrence']['type'] : 'daily'
  const weekdays = Array.isArray(recurrence.weekdays) ? [...new Set(recurrence.weekdays.filter(day => Number.isInteger(day) && Number(day) >= 0 && Number(day) <= 6) as number[])] : undefined
  return { id: value.id, title: value.title, section: sections.has(String(value.section)) ? value.section as Routine['section'] : 'Morning', recurrence: { type, weekdays: type === 'weekdays-custom' ? weekdays?.length ? weekdays : [1] : undefined }, active: value.active !== false, goalId: typeof value.goalId === 'string' ? value.goalId : undefined, createdAt: isTimestamp(value.createdAt) ? value.createdAt : now() }
}

function normalizeEvidence(value: unknown): Evidence | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || !['photo', 'screenshot', 'number', 'milestone'].includes(String(value.kind)) || !isTimestamp(value.capturedAt)) return undefined
  return { id: value.id, goalId: typeof value.goalId === 'string' ? value.goalId : undefined, scheduleId: typeof value.scheduleId === 'string' ? value.scheduleId : undefined, kind: value.kind as Evidence['kind'], capturedAt: value.capturedAt, note: typeof value.note === 'string' ? value.note : undefined, mediaId: typeof value.mediaId === 'string' ? value.mediaId : undefined, value: typeof value.value === 'number' && Number.isFinite(value.value) ? value.value : undefined, milestoneId: typeof value.milestoneId === 'string' ? value.milestoneId : undefined }
}

function normalizeWin(value: unknown): Win | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || typeof value.title !== 'string' || !value.title || !isTimestamp(value.createdAt)) return undefined
  return { id: value.id, title: value.title, note: typeof value.note === 'string' ? value.note : undefined, goalId: typeof value.goalId === 'string' ? value.goalId : undefined, mediaId: typeof value.mediaId === 'string' ? value.mediaId : undefined, createdAt: value.createdAt }
}

function normalizeProgress(value: unknown): ProgressEntry | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || typeof value.goalId !== 'string' || !value.goalId || typeof value.value !== 'number' || !Number.isFinite(value.value) || !isTimestamp(value.recordedAt)) return undefined
  return { id: value.id, goalId: value.goalId, value: value.value, recordedAt: value.recordedAt, note: typeof value.note === 'string' ? value.note : undefined }
}

function normalizePeriod(value: unknown): PeriodRecord | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || !['week', 'month', '3M', '6M', 'year'].includes(String(value.kind)) || !isDate(value.start) || !isDate(value.end) || value.start > value.end || !isDate(value.availableAt)) return undefined
  return { id: value.id, kind: value.kind as PeriodRecord['kind'], start: value.start, end: value.end, availableAt: value.availableAt, finalized: Boolean(value.finalized) }
}

export function migrateSnapshot(value: unknown, date = new Date()): AppData {
  if (!value || typeof value !== 'object') return createInitialData(date)
  const source = value as Partial<AppData>
  const initial = createInitialData(date)
  const fallbacks = seededGoals(date)
  const normalizedGoals = Array.isArray(source.goals)
    ? unique(source.goals.filter(isRecord).flatMap(raw => {
      if (typeof raw.id !== 'string' || !raw.id || typeof raw.title !== 'string' || !raw.title) return []
      const id = raw.id
      const title = raw.title
      const goal = raw as unknown as Partial<Goal>
      const matched = fallbacks.find(item => item.id === goal.id || item.title === goal.title)
      const fallback: Goal = matched || { ...initial.goals[0], id, title, horizon: horizons.has(String(goal.horizon)) ? goal.horizon! : '1M', kind: kinds.has(String(goal.kind)) ? goal.kind! : 'qualitative', target: undefined, baseline: undefined, current: undefined, unit: undefined, milestones: [], links: [], history: [], evidenceSchedules: [], status: 'active', createdAt: isTimestamp(goal.createdAt) ? goal.createdAt : now(), deadline: deadlineFor(horizons.has(String(goal.horizon)) ? goal.horizon! : '1M') }
      return [normalizeGoal(goal, fallback)]
    }))
    : initial.goals
  const goalIds = new Set(normalizedGoals.map(goal => goal.id))
  const goals = normalizedGoals.map(goal => ({
    ...goal,
    links: [...new Set(goal.links.filter(link => link !== goal.id && goalIds.has(link)))],
  }))
  const goalsById = new Map(goals.map(goal => [goal.id, goal]))
  const routines = Array.isArray(source.routines) ? unique(source.routines.map(normalizeRoutine).filter((item): item is Routine => Boolean(item)).map(item => ({ ...item, goalId: item.goalId && goalIds.has(item.goalId) ? item.goalId : undefined }))) : seededRoutines()
  const rawAi: Record<string, unknown> = isRecord(source.settings?.ai) ? source.settings.ai as unknown as Record<string, unknown> : {}
  const rawReminders: Record<string, unknown> = isRecord(source.settings?.reminders) ? source.settings.reminders as unknown as Record<string, unknown> : {}
  const settings: Settings = {
    areas: Array.isArray(source.settings?.areas) && source.settings.areas.every(area => typeof area === 'string') && source.settings.areas.length ? source.settings.areas : initial.settings.areas,
    ai: {
      enabled: typeof rawAi.enabled === 'boolean' ? rawAi.enabled : initial.settings.ai.enabled,
      monthlyCap: typeof rawAi.monthlyCap === 'number' && Number.isFinite(rawAi.monthlyCap) && rawAi.monthlyCap >= 0 ? rawAi.monthlyCap : initial.settings.ai.monthlyCap,
      month: typeof rawAi.month === 'string' && /^\d{4}-\d{2}$/.test(rawAi.month) ? rawAi.month : initial.settings.ai.month,
      estimatedCost: typeof rawAi.estimatedCost === 'number' && Number.isFinite(rawAi.estimatedCost) && rawAi.estimatedCost >= 0 ? rawAi.estimatedCost : 0,
      inputTokens: Number.isSafeInteger(rawAi.inputTokens) && Number(rawAi.inputTokens) >= 0 ? Number(rawAi.inputTokens) : 0,
      outputTokens: Number.isSafeInteger(rawAi.outputTokens) && Number(rawAi.outputTokens) >= 0 ? Number(rawAi.outputTokens) : 0,
      requests: Number.isSafeInteger(rawAi.requests) && Number(rawAi.requests) >= 0 ? Number(rawAi.requests) : 0,
    },
    reminders: {
      morning: typeof rawReminders.morning === 'boolean' ? rawReminders.morning : initial.settings.reminders.morning,
      evidence: typeof rawReminders.evidence === 'boolean' ? rawReminders.evidence : initial.settings.reminders.evidence,
      recap: typeof rawReminders.recap === 'boolean' ? rawReminders.recap : initial.settings.reminders.recap,
      deadline: typeof rawReminders.deadline === 'boolean' ? rawReminders.deadline : initial.settings.reminders.deadline,
    },
  }
  const tasks = Array.isArray(source.tasks) ? unique(source.tasks.filter(isRecord).map(item => normalizeTask(item as Partial<Task>)).filter((item): item is Task => Boolean(item)).map(item => ({ ...item, goalId: item.goalId && goalIds.has(item.goalId) ? item.goalId : undefined, rolledToId: item.rolledToId === item.id ? undefined : item.rolledToId }))) : []
  const evidence = Array.isArray(source.evidence) ? unique(source.evidence.map(normalizeEvidence).filter((item): item is Evidence => Boolean(item)).map(item => {
    const goal = item.goalId ? goalsById.get(item.goalId) : undefined
    return {
      ...item,
      goalId: goal ? item.goalId : undefined,
      scheduleId: goal && item.scheduleId && goal.evidenceSchedules.some(schedule => schedule.id === item.scheduleId) ? item.scheduleId : undefined,
      milestoneId: goal && item.milestoneId && goal.milestones.some(milestone => milestone.id === item.milestoneId) ? item.milestoneId : undefined,
    }
  })) : []
  const wins = Array.isArray(source.wins) ? unique(source.wins.map(normalizeWin).filter((item): item is Win => Boolean(item)).map(item => ({ ...item, goalId: item.goalId && goalIds.has(item.goalId) ? item.goalId : undefined }))) : []
  const progress = Array.isArray(source.progress) ? unique(source.progress.map(normalizeProgress).filter((item): item is ProgressEntry => item !== undefined).filter(item => goalIds.has(item.goalId))) : []
  const periods = Array.isArray(source.periods) ? unique(source.periods.map(normalizePeriod).filter((item): item is PeriodRecord => Boolean(item))) : []
  return {
    ...initial,
    ...source,
    schema: 2,
    goals,
    tasks,
    routines,
    evidence,
    wins,
    progress,
    periods,
    settings,
    onboarded: Boolean(source.onboarded),
    updatedAt: isTimestamp(source.updatedAt) ? source.updatedAt : now(),
  }
}
