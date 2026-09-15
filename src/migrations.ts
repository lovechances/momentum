import type {
  AppData, Evidence, Goal, MeasurementHistory, PeriodRecord, ProgressEntry,
  ProgressLinkSuggestion, ReminderOccurrence, Routine, RoutineExclusion, Settings, Task, Win,
} from './domain'
import { compareProgressEntries, evidenceGoalIds, localDateOf, recordedDateOf, timestampForLocalDate, todayLocal } from './domain'
import { createInitialData, seededGoals, seededRoutines } from './seed'
import { completeGoal, deadlineFor, defaultEvidenceSchedulesForGoal, legacyDeadlineFor, numericTargetReached, planningAnchorFor, progressHistoryId } from './goals'
import { evidenceTrackKey, periodFor, remapEvidenceReminderOccurrences } from './scheduler'

const statuses = new Set(['active', 'paused', 'completed', 'closed'])
const kinds = new Set(['numeric', 'binary', 'milestone', 'consistency', 'qualitative'])
const horizons = new Set(['1M', '3M', '6M', '1Y', '2Y'])
const sections = new Set(['Morning', 'Moves That Matter', 'Day', 'Evening'])
const taskKinds = new Set(['task', 'routine', 'move'])
const taskStatuses = new Set(['active', 'rolled', 'dropped', 'excluded', 'deleted'])
const evidenceKinds = new Set(['photo', 'screenshot', 'number', 'milestone', 'note'])
const historyActions = new Set(['created', 'continued', 'adjusted', 'closed', 'completed', 'progressed', 'paused', 'resumed', 'reopened', 'milestone'])
const deadlineProvenance = new Set(['calendar-default', 'manual', 'legacy-unknown'])
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const isTimestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
const isDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}
const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item)) : []
const unique = <T extends { id: string }>(values: T[]) => values.filter((value, index) => values.findIndex(item => item.id === value.id) === index)

function normalizeGoal(value: Partial<Goal>, fallback: Goal, legacy: boolean): Goal {
  const baseline = typeof value.baseline === 'number' && Number.isFinite(value.baseline) ? value.baseline : undefined
  const current = typeof value.current === 'number' && Number.isFinite(value.current) ? value.current : undefined
  const target = typeof value.target === 'number' && Number.isFinite(value.target) ? value.target : undefined
  const hasProgress = current !== undefined || baseline !== undefined
  const wasScaffoldValue = /^g(?:[1-9]|1\d)$/.test(value.id || '')
    && fallback.title === value.title
    && (!Array.isArray(value.history) || value.history.length === 0)
  const createdAt = isTimestamp(value.createdAt) ? value.createdAt : fallback.createdAt
  const horizon = horizons.has(String(value.horizon)) ? value.horizon! : fallback.horizon
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
  const numeric = (wasScaffoldValue ? fallback.kind : kinds.has(String(value.kind)) ? value.kind! : fallback.kind) === 'numeric'
  const measurementHistoryId = numeric
    ? typeof value.measurementHistoryId === 'string' && value.measurementHistoryId ? value.measurementHistoryId : `measurement:${value.id ?? fallback.id}`
    : undefined
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
    horizon,
    deadline: isDate(value.deadline) ? value.deadline : deadlineFor(horizon, new Date(createdAt)),
    deadlineAnchor: isDate(value.deadlineAnchor) ? value.deadlineAnchor : planningAnchorFor(createdAt),
    deadlineProvenance: legacy
      ? isDate(value.deadline) && value.deadline !== legacyDeadlineFor(horizon, new Date(createdAt)) ? 'manual' : 'legacy-unknown'
      : deadlineProvenance.has(String(value.deadlineProvenance)) ? value.deadlineProvenance : 'legacy-unknown',
    measurementHistoryId,
    contextNotes: strings(value.contextNotes),
    area: typeof value.area === 'string' ? value.area : fallback.area,
    color: typeof value.color === 'string' ? value.color : fallback.color,
    nextAction: typeof value.nextAction === 'string' ? value.nextAction : undefined,
    milestones: Array.isArray(value.milestones) ? unique(value.milestones.filter(item => isRecord(item) && typeof item.id === 'string' && Boolean(item.id) && typeof item.title === 'string' && Boolean(item.title) && typeof item.done === 'boolean').map(item => ({ id: item.id as string, title: item.title as string, done: item.done as boolean, completedAt: isTimestamp(item.completedAt) ? item.completedAt : undefined }))) : [],
    links: strings(value.links),
    history: history.length ? history : [{ at: createdAt, action: 'created', current: wasScaffoldValue ? undefined : hasProgress ? current : undefined, target: wasScaffoldValue ? fallback.target : target, deadline: isDate(value.deadline) ? value.deadline : fallback.deadline }],
    evidenceSchedules: Array.isArray(value.evidenceSchedules) ? unique(value.evidenceSchedules.filter(item => isRecord(item) && typeof item.id === 'string' && Boolean(item.id) && evidenceKinds.has(String(item.kind)) && ['weekly', 'monthly', 'quarterly'].includes(String(item.cadence)) && typeof item.active === 'boolean').map(item => ({
      id: item.id as string,
      kind: item.kind as Goal['evidenceSchedules'][number]['kind'],
      cadence: item.cadence as Goal['evidenceSchedules'][number]['cadence'],
      historyId: typeof item.historyId === 'string' ? item.historyId : measurementHistoryId,
      lastCapturedAt: isTimestamp(item.lastCapturedAt) ? item.lastCapturedAt : undefined,
      firstDueDate: isDate(item.firstDueDate) ? item.firstDueDate : undefined,
      active: item.active as boolean,
    }))) : fallback.evidenceSchedules.map(schedule => ({ ...schedule, historyId: schedule.historyId ?? measurementHistoryId })),
    createdAt,
  }
}

function normalizeTask(value: Partial<Task>, fallbackAt: string): Task | undefined {
  if (typeof value.id !== 'string' || !value.id || typeof value.title !== 'string' || !value.title) return undefined
  return {
    id: value.id, title: value.title, details: typeof value.details === 'string' ? value.details : undefined, section: sections.has(String(value.section)) ? value.section! : 'Day', done: Boolean(value.done),
    kind: taskKinds.has(String(value.kind)) ? value.kind! : 'task', goalId: typeof value.goalId === 'string' ? value.goalId : undefined, dueDate: isDate(value.dueDate) ? value.dueDate : localDateOf(fallbackAt),
    sourceRoutineId: typeof value.sourceRoutineId === 'string' ? value.sourceRoutineId : undefined, createdAt: isTimestamp(value.createdAt) ? value.createdAt : fallbackAt, carriedCount: Number.isInteger(value.carriedCount) && value.carriedCount! >= 0 ? value.carriedCount! : 0,
    lightDay: typeof value.lightDay === 'boolean' ? value.lightDay : undefined,
    status: taskStatuses.has(String(value.status)) ? value.status : 'active',
    resolvedAt: isTimestamp(value.resolvedAt) ? value.resolvedAt : undefined,
    rolledToId: typeof value.rolledToId === 'string' ? value.rolledToId : undefined,
    history: Array.isArray(value.history) ? value.history.filter(item => isRecord(item) && isTimestamp(item.at) && ['edited', 'deleted', 'restored', 'excluded', 'completed', 'reopened'].includes(String(item.action))).map(item => ({
      at: item.at as string, action: item.action as NonNullable<Task['history']>[number]['action'],
      title: typeof item.title === 'string' ? item.title : undefined,
      details: typeof item.details === 'string' ? item.details : undefined,
      section: sections.has(String(item.section)) ? item.section as Task['section'] : undefined,
      dueDate: isDate(item.dueDate) ? item.dueDate : undefined,
      kind: taskKinds.has(String(item.kind)) ? item.kind as Task['kind'] : undefined,
      goalId: typeof item.goalId === 'string' ? item.goalId : undefined,
    })) : [],
  }
}

function normalizeRoutine(value: unknown, fallbackAt: string): Routine | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || typeof value.title !== 'string' || !value.title) return undefined
  const recurrence = isRecord(value.recurrence) ? value.recurrence : {}
  const type = ['daily', 'weekdays', 'weekdays-custom'].includes(String(recurrence.type)) ? recurrence.type as Routine['recurrence']['type'] : 'daily'
  const weekdays = Array.isArray(recurrence.weekdays) ? [...new Set(recurrence.weekdays.filter(day => Number.isInteger(day) && Number(day) >= 0 && Number(day) <= 6) as number[])] : undefined
  return { id: value.id, title: value.title, section: sections.has(String(value.section)) ? value.section as Routine['section'] : 'Morning', recurrence: { type, weekdays: type === 'weekdays-custom' ? weekdays?.length ? weekdays : [1] : undefined }, active: value.active !== false, goalId: typeof value.goalId === 'string' ? value.goalId : undefined, createdAt: isTimestamp(value.createdAt) ? value.createdAt : fallbackAt, stoppedAt: isTimestamp(value.stoppedAt) ? value.stoppedAt : undefined }
}

function normalizeEvidence(value: unknown): Evidence | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || !evidenceKinds.has(String(value.kind)) || !isTimestamp(value.capturedAt)) return undefined
  const goalId = typeof value.goalId === 'string' ? value.goalId : undefined
  const goalIds = [...new Set([...strings(value.goalIds), ...(goalId ? [goalId] : [])])]
  return { id: value.id, goalId: goalId ?? goalIds[0], goalIds, historyId: typeof value.historyId === 'string' ? value.historyId : undefined, observationId: typeof value.observationId === 'string' ? value.observationId : undefined, scheduleId: typeof value.scheduleId === 'string' ? value.scheduleId : undefined, kind: value.kind as Evidence['kind'], capturedAt: value.capturedAt, recordedOn: isDate(value.recordedOn) ? value.recordedOn : localDateOf(value.capturedAt), note: typeof value.note === 'string' ? value.note : undefined, mediaId: typeof value.mediaId === 'string' ? value.mediaId : undefined, value: typeof value.value === 'number' && Number.isFinite(value.value) ? value.value : undefined, milestoneId: typeof value.milestoneId === 'string' ? value.milestoneId : undefined }
}

function normalizeWin(value: unknown): Win | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || typeof value.title !== 'string' || !value.title || !isTimestamp(value.createdAt)) return undefined
  const goalId = typeof value.goalId === 'string' ? value.goalId : undefined
  const goalIds = [...new Set([...strings(value.goalIds), ...(goalId ? [goalId] : [])])]
  return { id: value.id, title: value.title, note: typeof value.note === 'string' ? value.note : undefined, goalId: goalId ?? goalIds[0], goalIds, mediaId: typeof value.mediaId === 'string' ? value.mediaId : undefined, createdAt: value.createdAt, recordedOn: isDate(value.recordedOn) ? value.recordedOn : localDateOf(value.createdAt) }
}

function normalizeProgress(value: unknown): ProgressEntry | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || typeof value.goalId !== 'string' || !value.goalId || typeof value.value !== 'number' || !Number.isFinite(value.value) || !isTimestamp(value.recordedAt)) return undefined
  return { id: value.id, goalId: value.goalId, historyId: typeof value.historyId === 'string' ? value.historyId : undefined, value: value.value, recordedAt: value.recordedAt, recordedOn: isDate(value.recordedOn) ? value.recordedOn : localDateOf(value.recordedAt), note: typeof value.note === 'string' ? value.note : undefined }
}

function normalizePeriod(value: unknown): PeriodRecord | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || !['week', 'month', '3M', '6M', 'year'].includes(String(value.kind)) || !isDate(value.start) || !isDate(value.end) || value.start > value.end || !isDate(value.availableAt)) return undefined
  return { id: value.id, kind: value.kind as PeriodRecord['kind'], start: value.start, end: value.end, availableAt: value.availableAt, finalized: Boolean(value.finalized), anchorMonth: isDate(value.anchorMonth) ? value.anchorMonth : undefined, effectiveStart: isDate(value.effectiveStart) ? value.effectiveStart : undefined }
}

function normalizeMeasurementHistory(value: unknown): MeasurementHistory | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || typeof value.label !== 'string' || !value.label || !isTimestamp(value.createdAt)) return undefined
  const semanticKey = value.semanticKey === 'body-weight' || value.semanticKey === 'savings-balance' ? value.semanticKey : undefined
  return { id: value.id, label: value.label, unit: typeof value.unit === 'string' ? value.unit : undefined, semanticKey, scopeKey: typeof value.scopeKey === 'string' ? value.scopeKey : undefined, createdAt: value.createdAt, mergedIntoId: typeof value.mergedIntoId === 'string' ? value.mergedIntoId : undefined }
}

function normalizeSuggestion(value: unknown): ProgressLinkSuggestion | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || typeof value.label !== 'string' || !value.label || !['pending', 'confirmed', 'dismissed'].includes(String(value.status)) || !isTimestamp(value.createdAt)) return undefined
  return { id: value.id, label: value.label, goalIds: [...new Set(strings(value.goalIds))], historyIds: [...new Set(strings(value.historyIds))], status: value.status as ProgressLinkSuggestion['status'], createdAt: value.createdAt }
}

function normalizeExclusion(value: unknown): RoutineExclusion | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || typeof value.routineId !== 'string' || !value.routineId || !isDate(value.date) || !isTimestamp(value.createdAt)) return undefined
  return { id: value.id, routineId: value.routineId, date: value.date, createdAt: value.createdAt }
}

function normalizeOccurrence(value: unknown): ReminderOccurrence | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || typeof value.trackId !== 'string' || !value.trackId || typeof value.scheduleId !== 'string' || !value.scheduleId || !isDate(value.dueDate) || !['due', 'snoozed', 'skipped', 'satisfied'].includes(String(value.status))) return undefined
  return { id: value.id, trackId: value.trackId, scheduleId: value.scheduleId, dueDate: value.dueDate, status: value.status as ReminderOccurrence['status'], snoozedUntil: isDate(value.snoozedUntil) ? value.snoozedUntil : undefined, handledAt: isTimestamp(value.handledAt) ? value.handledAt : undefined, satisfiedByEntryId: typeof value.satisfiedByEntryId === 'string' ? value.satisfiedByEntryId : undefined }
}

function semanticGroup(goal: Goal) {
  if (goal.kind !== 'numeric') return undefined
  if (goal.unit?.trim().toLowerCase() === 'lbs' && /(?:lbs|weight)/i.test(goal.title)) return { id: 'body-weight', label: 'Weight' }
  if (goal.unit?.trim().toUpperCase() === 'USD' && /(?:stacked|savings?)/i.test(goal.title)) return { id: 'savings-balance', label: 'Savings' }
  return undefined
}

function addLegacyScheduleDefaults(goal: Goal) {
  if (goal.status !== 'active') return goal
  const schedules = goal.evidenceSchedules.length ? goal.evidenceSchedules : defaultEvidenceSchedulesForGoal(goal)
  const savings = semanticGroup(goal)?.id === 'savings-balance'
  return {
    ...goal,
    evidenceSchedules: schedules.map(schedule => savings
      && schedule.id === `${goal.id}-screenshot`
      && schedule.kind === 'screenshot'
      && schedule.cadence === 'monthly'
      ? { ...schedule, active: false }
      : schedule),
  }
}

function suggestedLinks(goals: Goal[], createdAt: string) {
  const groups = new Map<string, { label: string; goals: Goal[] }>()
  for (const goal of goals) {
    const semantic = semanticGroup(goal)
    if (!semantic) continue
    const group = groups.get(semantic.id) ?? { label: semantic.label, goals: [] }
    group.goals.push(goal)
    groups.set(semantic.id, group)
  }
  return [...groups.entries()].flatMap(([id, group]) => group.goals.length < 2 ? [] : [{
    id: `link-suggestion:${id}`,
    label: group.label,
    goalIds: group.goals.map(goal => goal.id),
    historyIds: group.goals.map(progressHistoryId),
    status: 'pending' as const,
    createdAt,
  }])
}

export function migrateSnapshot(value: unknown, date = new Date()): AppData {
  if (!value || typeof value !== 'object') return createInitialData(date)
  const source = value as Record<string, unknown>
  const legacy = source.schema !== 3
  const initial = createInitialData(date)
  const fallbackAt = isTimestamp(source.updatedAt) ? source.updatedAt : date.toISOString()
  const fallbacks = seededGoals(date)
  const sourceGoals = Array.isArray(source.goals) ? source.goals : undefined
  const normalizedGoals = sourceGoals
    ? unique(sourceGoals.filter(isRecord).flatMap(raw => {
      if (typeof raw.id !== 'string' || !raw.id || typeof raw.title !== 'string' || !raw.title) return []
      const goal = raw as unknown as Partial<Goal>
      const matched = fallbacks.find(item => item.id === goal.id || item.title === goal.title)
      const fallback: Goal = matched || { ...initial.goals[0], id: raw.id as string, title: raw.title as string, horizon: horizons.has(String(goal.horizon)) ? goal.horizon! : '1M', kind: kinds.has(String(goal.kind)) ? goal.kind! : 'qualitative', target: undefined, baseline: undefined, current: undefined, unit: undefined, milestones: [], links: [], history: [], evidenceSchedules: [], status: 'active', createdAt: isTimestamp(goal.createdAt) ? goal.createdAt : fallbackAt, deadline: deadlineFor(horizons.has(String(goal.horizon)) ? goal.horizon! : '1M', new Date(isTimestamp(goal.createdAt) ? goal.createdAt : fallbackAt)) }
      const normalized = normalizeGoal(goal, fallback, legacy)
      return [legacy ? addLegacyScheduleDefaults(normalized) : normalized]
    }))
    : initial.goals
  const goalIds = new Set(normalizedGoals.map(goal => goal.id))
  const goals = normalizedGoals.map(goal => ({ ...goal, links: [...new Set(goal.links.filter(link => link !== goal.id && goalIds.has(link)))] }))
  const goalsById = new Map(goals.map(goal => [goal.id, goal]))

  const sourceHistories = Array.isArray(source.measurementHistories) ? source.measurementHistories.map(normalizeMeasurementHistory).filter((item): item is MeasurementHistory => Boolean(item)) : []
  const measurementHistories = unique([
    ...sourceHistories,
    ...goals.filter(goal => goal.kind === 'numeric' && !sourceHistories.some(history => history.id === progressHistoryId(goal))).map(goal => {
      const semantic = semanticGroup(goal)
      return { id: progressHistoryId(goal), label: semantic?.label ?? goal.title, unit: goal.unit, semanticKey: semantic?.id === 'body-weight' ? 'body-weight' as const : semantic?.id === 'savings-balance' ? 'savings-balance' as const : undefined, scopeKey: semantic?.id === 'body-weight' ? 'body' : semantic?.id === 'savings-balance' ? 'primary-savings-pool' : undefined, createdAt: goal.createdAt }
    }),
  ])
  const historyIds = new Set(measurementHistories.map(history => history.id))

  const sourceRoutines = Array.isArray(source.routines) ? source.routines : undefined
  const routines = sourceRoutines ? unique(sourceRoutines.map(item => normalizeRoutine(item, fallbackAt)).filter((item): item is Routine => Boolean(item)).map(item => ({ ...item, goalId: item.goalId && goalIds.has(item.goalId) ? item.goalId : undefined }))) : seededRoutines(fallbackAt)
  const sourceSettings = isRecord(source.settings) ? source.settings : {}
  const rawAi = isRecord(sourceSettings.ai) ? sourceSettings.ai : {}
  const rawReminders = isRecord(sourceSettings.reminders) ? sourceSettings.reminders : {}
  const settings: Settings = {
    areas: Array.isArray(sourceSettings.areas) && sourceSettings.areas.every(area => typeof area === 'string') && sourceSettings.areas.length ? sourceSettings.areas as string[] : initial.settings.areas,
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
  const tasks = Array.isArray(source.tasks) ? unique(source.tasks.filter(isRecord).map(item => normalizeTask(item as Partial<Task>, fallbackAt)).filter((item): item is Task => Boolean(item)).map(item => ({ ...item, goalId: item.goalId && goalIds.has(item.goalId) ? item.goalId : undefined, rolledToId: item.rolledToId === item.id ? undefined : item.rolledToId }))) : []
  const evidence = Array.isArray(source.evidence) ? unique(source.evidence.map(normalizeEvidence).filter((item): item is Evidence => Boolean(item)).map(item => {
    const validGoalIds = evidenceGoalIds(item).filter(id => goalIds.has(id))
    const primaryGoal = validGoalIds[0] ? goalsById.get(validGoalIds[0]) : undefined
    const validHistoryId = item.historyId && historyIds.has(item.historyId) ? item.historyId : primaryGoal?.measurementHistoryId
    return {
      ...item,
      goalId: validGoalIds[0], goalIds: validGoalIds, historyId: validHistoryId,
      scheduleId: item.scheduleId && validGoalIds.some(goalId => goalsById.get(goalId)?.evidenceSchedules.some(schedule => schedule.id === item.scheduleId)) ? item.scheduleId : undefined,
      milestoneId: item.milestoneId && validGoalIds.some(goalId => goalsById.get(goalId)?.milestones.some(milestone => milestone.id === item.milestoneId)) ? item.milestoneId : undefined,
    }
  })) : []
  const wins = Array.isArray(source.wins) ? unique(source.wins.map(normalizeWin).filter((item): item is Win => Boolean(item)).map(item => { const validGoalIds = evidenceGoalIds(item).filter(id => goalIds.has(id)); return { ...item, goalId: validGoalIds[0], goalIds: validGoalIds } })) : []
  const progress = Array.isArray(source.progress) ? unique(source.progress.map(normalizeProgress).filter((item): item is ProgressEntry => item !== undefined).filter(item => goalIds.has(item.goalId)).map(item => ({ ...item, historyId: item.historyId && historyIds.has(item.historyId) ? item.historyId : progressHistoryId(goalsById.get(item.goalId)!) }))) : []
  const sourcePeriods = Array.isArray(source.periods) ? unique(source.periods.map(normalizePeriod).filter((item): item is PeriodRecord => Boolean(item))) : []
  const routineIds = new Set(routines.map(routine => routine.id))
  const routineExclusions = Array.isArray(source.routineExclusions) ? unique(source.routineExclusions.map(normalizeExclusion).filter((item): item is RoutineExclusion => Boolean(item)).filter(item => routineIds.has(item.routineId))) : []
  const reminderOccurrences = Array.isArray(source.reminderOccurrences) ? unique(source.reminderOccurrences.map(normalizeOccurrence).filter((item): item is ReminderOccurrence => Boolean(item))) : []
  const allDates = [
    ...goals.map(goal => localDateOf(goal.createdAt)), ...tasks.map(task => localDateOf(task.createdAt)),
    ...progress.map(item => item.recordedOn!), ...evidence.map(item => item.recordedOn!), ...wins.map(item => item.recordedOn!),
  ].sort()
  const rawPlanning = isRecord(source.planning) ? source.planning : {}
  const trackingStartedOn = isDate(rawPlanning.trackingStartedOn) ? rawPlanning.trackingStartedOn : allDates[0] ?? todayLocal(date)
  const planning = {
    anchorMonth: isDate(rawPlanning.anchorMonth) ? rawPlanning.anchorMonth : planningAnchorFor(trackingStartedOn),
    trackingStartedOn,
  }
  const periods = unique(sourcePeriods.flatMap(period => {
    if (!legacy) return [period]
    const aligned = periodFor(period.kind, period.start, planning.anchorMonth, planning.trackingStartedOn)
    const alignedBounds = aligned.start === period.start && aligned.end === period.end
    if (alignedBounds) return [{ ...aligned, finalized: period.finalized }]
    // Legacy long periods were generated from calendar quarters/halves/years.
    // Unreviewed metadata can be regenerated on the persisted plan anchor;
    // reviewed records stay as explicit historical ranges.
    if (!period.finalized && (period.kind === '3M' || period.kind === '6M' || period.kind === 'year')) return []
    const effectiveStart = period.effectiveStart
      ?? (planning.trackingStartedOn > period.start && planning.trackingStartedOn <= period.end ? planning.trackingStartedOn : undefined)
    return [{ ...period, anchorMonth: period.anchorMonth ?? period.start, effectiveStart }]
  }))
  const suggestions = Array.isArray(source.progressLinkSuggestions)
    ? unique(source.progressLinkSuggestions.map(normalizeSuggestion).filter((item): item is ProgressLinkSuggestion => Boolean(item)).map(item => ({ ...item, goalIds: item.goalIds.filter(id => goalIds.has(id)), historyIds: item.historyIds.filter(id => historyIds.has(id)) })))
    : suggestedLinks(goals, fallbackAt)
  return {
    schema: 3,
    goals, tasks, routines, evidence, wins, progress, measurementHistories,
    progressLinkSuggestions: suggestions,
    routineExclusions, reminderOccurrences, planning, periods, settings,
    onboarded: Boolean(source.onboarded),
    updatedAt: isTimestamp(source.updatedAt) ? source.updatedAt : fallbackAt,
  }
}

function progressLinkState(data: AppData, suggestionId: string, selectedGoalIds?: string[]) {
  const suggestion = data.progressLinkSuggestions.find(item => item.id === suggestionId)
  if (!suggestion) return undefined
  const selected = suggestion.goalIds.filter(id => !selectedGoalIds || selectedGoalIds.includes(id))
  const goals = selected.flatMap(id => data.goals.find(goal => goal.id === id) ?? [])
  const oldHistoryIds = new Set(goals.map(progressHistoryId))
  const latest = data.progress
    .filter(entry => oldHistoryIds.has(entry.historyId ?? `measurement:${entry.goalId}`))
    .sort(compareProgressEntries)
    .at(-1)
  return { suggestion, selected, goals, oldHistoryIds, latest }
}

export function progressLinkCompletionPreview(data: AppData, suggestionId: string, selectedGoalIds?: string[]) {
  const state = progressLinkState(data, suggestionId, selectedGoalIds)
  if (!state?.latest) return []
  return state.goals.flatMap(goal => {
    const candidate = { ...goal, baseline: goal.baseline ?? state.latest!.value, current: state.latest!.value }
    return goal.status === 'active'
      && recordedDateOf(state.latest!) >= localDateOf(goal.createdAt)
      && numericTargetReached(candidate)
      ? [{ goalId: goal.id, title: goal.title, current: state.latest!.value, target: goal.target }]
      : []
  })
}

/** Explicit user confirmation is the only operation that joins measurement histories. */
export function confirmProgressLinkSuggestion(data: AppData, suggestionId: string, selectedGoalIds?: string[], confirmReached = false): AppData {
  const state = progressLinkState(data, suggestionId, selectedGoalIds)
  if (!state || state.suggestion.status === 'confirmed') return data
  const { suggestion, selected, goals, oldHistoryIds } = state
  if (selected.length < 2) return { ...data, progressLinkSuggestions: data.progressLinkSuggestions.map(item => item.id === suggestionId ? { ...item, status: 'dismissed' } : item) }
  const reached = progressLinkCompletionPreview(data, suggestionId, selectedGoalIds)
  if (reached.length && !confirmReached) return data
  const reachedIds = new Set(reached.map(item => item.goalId))
  const affectedGoalIds = new Set(data.goals
    .filter(goal => oldHistoryIds.has(progressHistoryId(goal)))
    .map(goal => goal.id))
  const affectedGoals = data.goals.filter(goal => affectedGoalIds.has(goal.id))
  const canonicalId = `measurement:shared:${suggestion.id.replace(/^link-suggestion:/, '')}`
  const earliest = affectedGoals.map(goal => goal.createdAt).sort()[0]
  const canonical: MeasurementHistory = {
    id: canonicalId,
    label: suggestion.label,
    unit: goals.map(goal => goal.unit).find(Boolean),
    semanticKey: suggestion.id.endsWith('body-weight') ? 'body-weight' : suggestion.id.endsWith('savings-balance') ? 'savings-balance' : undefined,
    scopeKey: suggestion.id.endsWith('body-weight') ? 'body' : suggestion.id.endsWith('savings-balance') ? 'primary-savings-pool' : undefined,
    createdAt: earliest,
  }
  const progress = data.progress.map(entry => oldHistoryIds.has(entry.historyId ?? `measurement:${entry.goalId}`) ? { ...entry, historyId: canonicalId } : entry)
  const latestEntry = progress.filter(entry => entry.historyId === canonicalId).sort(compareProgressEntries).at(-1)
  const goalsAfterLink = data.goals.map(goal => {
    if (!affectedGoalIds.has(goal.id)) return goal
    const linked = {
      ...goal,
      measurementHistoryId: canonicalId,
      current: latestEntry?.value ?? goal.current,
      evidenceSchedules: goal.evidenceSchedules.map(schedule => ({ ...schedule, historyId: canonicalId })),
    }
    return reachedIds.has(goal.id) && latestEntry
      ? completeGoal(linked, timestampForLocalDate(latestEntry.recordedOn ?? localDateOf(latestEntry.recordedAt), latestEntry.recordedAt), 'Target reached by confirmed shared measurement history')
      : linked
  })
  const trackChanges = new Map<string, string>()
  for (const goal of data.goals.filter(item => affectedGoalIds.has(item.id))) {
    const linkedGoal = goalsAfterLink.find(item => item.id === goal.id)!
    for (const schedule of goal.evidenceSchedules) {
      const linkedSchedule = linkedGoal.evidenceSchedules.find(item => item.id === schedule.id)!
      trackChanges.set(
        evidenceTrackKey({ goal, schedule }),
        evidenceTrackKey({ goal: linkedGoal, schedule: linkedSchedule }),
      )
    }
  }
  return {
    ...data,
    goals: goalsAfterLink,
    measurementHistories: unique([
      canonical,
      ...data.measurementHistories.map(history => oldHistoryIds.has(history.id) ? { ...history, mergedIntoId: canonicalId } : history),
    ]),
    progress,
    evidence: data.evidence.map(item => item.historyId && oldHistoryIds.has(item.historyId) ? { ...item, historyId: canonicalId } : item),
    reminderOccurrences: remapEvidenceReminderOccurrences(data.reminderOccurrences, trackChanges),
    progressLinkSuggestions: data.progressLinkSuggestions.map(item => item.id === suggestionId ? { ...item, status: 'confirmed', goalIds: [...affectedGoalIds], historyIds: [canonicalId] } : item),
  }
}

export function dismissProgressLinkSuggestion(data: AppData, suggestionId: string): AppData {
  return { ...data, progressLinkSuggestions: data.progressLinkSuggestions.map(item => item.id === suggestionId ? { ...item, status: 'dismissed' } : item) }
}
