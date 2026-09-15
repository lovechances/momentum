import type { AppData, Goal, PeriodRecord, Task } from './domain'
import { evidenceGoalIds, recordedDateOf, todayLocal } from './domain'
import { evidenceCaptureGroups, recapFacts } from './recap'

const MAX_CONTEXT_CHARACTERS = 11_500
const text = (value: string | undefined, max = 180) => value?.trim().slice(0, max)

function orderedActiveGoals(data: AppData) {
  const horizon = new Map([['1M', 0], ['3M', 1], ['6M', 2], ['1Y', 3], ['2Y', 4]])
  return data.goals
    .filter(goal => goal.status === 'active')
    .sort((left, right) => (horizon.get(left.horizon) ?? 9) - (horizon.get(right.horizon) ?? 9)
      || left.deadline.localeCompare(right.deadline)
      || left.createdAt.localeCompare(right.createdAt)
      || left.title.localeCompare(right.title))
}

function compactGoal(goal: Goal) {
  return {
    id: goal.id,
    title: text(goal.title, 140),
    status: goal.status,
    horizon: goal.horizon,
    deadline: goal.deadline,
    nextAction: text(goal.nextAction, 220),
    contextNotes: goal.contextNotes?.slice(-4).map(item => text(item, 220)),
    unfinishedMilestones: goal.milestones.filter(item => !item.done).slice(0, 4).map(item => ({ id: item.id, title: text(item.title, 160) })),
    completedMilestones: goal.milestones.filter(item => item.done).slice(-2).map(item => ({ id: item.id, title: text(item.title, 160), completedAt: item.completedAt })),
    linkedGoalIds: goal.links.slice(0, 8),
    measurementHistoryId: goal.measurementHistoryId,
    current: goal.current,
    target: goal.target,
    unit: text(goal.unit, 32),
    direction: goal.direction,
  }
}

function compactTask(task: Task) {
  const status = task.status ?? 'active'
  return {
    id: task.id,
    title: text(task.title, 160),
    details: text(task.details, 360),
    goalId: task.goalId,
    kind: task.kind,
    sourceRoutineId: task.sourceRoutineId,
    section: task.section,
    dueDate: task.dueDate,
    done: task.done,
    status,
    resolvedAt: task.resolvedAt,
    outcome: task.done ? 'completed' : status === 'active' ? 'open' : status,
    recentHistory: task.history?.slice(-3).map(item => ({
      action: item.action,
      at: item.at,
      title: text(item.title, 160),
      details: text(item.details, 240),
      dueDate: item.dueDate,
    })),
  }
}

function relevantTasks(data: AppData, date: string, goalIds?: Set<string>, includeUnlinked = false) {
  const lowerBound = new Date(`${date}T12:00:00`)
  lowerBound.setDate(lowerBound.getDate() - 14)
  const recent = todayLocal(lowerBound)
  return data.tasks
    .filter(task => {
      const status = task.status ?? 'active'
      const visibleToday = task.dueDate === date && status === 'active'
      const unresolvedRollover = task.dueDate < date
        && !task.done
        && status === 'active'
        && task.kind !== 'routine'
        && !task.sourceRoutineId
      const historicalOutcome = task.dueDate >= recent
        && (task.done || status === 'dropped' || status === 'rolled')
      return (!goalIds || (task.goalId ? goalIds.has(task.goalId) : includeUnlinked))
        && (visibleToday || unresolvedRollover || historicalOutcome)
    })
    .sort((left, right) => Number(right.dueDate === date) - Number(left.dueDate === date)
      || right.dueDate.localeCompare(left.dueDate)
      || left.createdAt.localeCompare(right.createdAt))
}

function compactProgress(data: AppData, goalIds: Set<string>) {
  const historyGoalIds = new Map<string, string[]>()
  for (const goal of data.goals) {
    if (!goal.measurementHistoryId) continue
    historyGoalIds.set(goal.measurementHistoryId, [...(historyGoalIds.get(goal.measurementHistoryId) ?? []), goal.id])
  }
  const historyIds = new Set(data.goals.filter(goal => goalIds.has(goal.id)).flatMap(goal => goal.measurementHistoryId ? [goal.measurementHistoryId] : []))
  const observationIds = new Set(data.progress.map(entry => entry.id))
  const companions = new Map<string, typeof data.evidence>()
  for (const entry of data.evidence) {
    if (!entry.observationId || !observationIds.has(entry.observationId)) continue
    const values = companions.get(entry.observationId) ?? []
    values.push(entry)
    companions.set(entry.observationId, values)
  }
  const measurements = data.progress
    .filter(entry => {
      const relatedEvidence = companions.get(entry.id) ?? []
      return goalIds.has(entry.goalId)
        || Boolean(entry.historyId && historyIds.has(entry.historyId))
        || relatedEvidence.some(value => evidenceGoalIds(value).some(id => goalIds.has(id))
          || Boolean(value.historyId && historyIds.has(value.historyId)))
    })
    .map(entry => {
      const goal = data.goals.find(item => item.id === entry.goalId)
      const relatedEvidence = companions.get(entry.id) ?? []
      return {
        id: entry.id,
        type: 'measurement',
        goalIds: [...new Set([
          ...(entry.historyId ? historyGoalIds.get(entry.historyId) ?? [] : []),
          entry.goalId,
          ...relatedEvidence.flatMap(value => value.historyId ? historyGoalIds.get(value.historyId) ?? [] : []),
          ...relatedEvidence.flatMap(evidenceGoalIds),
        ])],
        historyId: entry.historyId,
        value: entry.value,
        unit: text(goal?.unit, 32),
        date: recordedDateOf(entry),
        note: text(entry.note || relatedEvidence.map(value => value.note).find(Boolean), 180),
      }
    })
  const standaloneEvidence = data.evidence.filter(entry => !entry.observationId || !observationIds.has(entry.observationId))
  const evidence = evidenceCaptureGroups({ evidence: standaloneEvidence })
    .filter(group => group.items.some(entry => evidenceGoalIds(entry).some(id => goalIds.has(id))
      || Boolean(entry.historyId && historyIds.has(entry.historyId))))
    .map(group => {
      const { canonical, representative, items } = group
      return {
        id: canonical.id,
        type: representative.kind,
        goalIds: [...new Set([
          ...items.flatMap(value => value.historyId ? historyGoalIds.get(value.historyId) ?? [] : []),
          ...group.goalIds,
        ])],
        date: recordedDateOf(canonical),
        note: text([representative, ...items].map(value => value.note).find(Boolean), 180),
        value: [representative, ...items].map(value => value.value).find(value => value !== undefined),
        // Deliberately omit mediaId and every image/blob field.
      }
    })
  const wins = data.wins
    .filter(entry => evidenceGoalIds(entry).some(id => goalIds.has(id)))
    .map(entry => ({
      id: entry.id,
      type: 'win',
      goalIds: evidenceGoalIds(entry),
      date: recordedDateOf(entry),
      title: text(entry.title, 160),
      note: text(entry.note, 180),
    }))
  return [...measurements, ...evidence, ...wins]
    .sort((left, right) => right.date.localeCompare(left.date) || left.id.localeCompare(right.id))
}

function fitContext<T extends { goal?: unknown; goals?: unknown[]; relatedGoals?: unknown[]; tasks?: unknown[]; recentProgress?: unknown[] }>(value: T): T {
  const context = structuredClone(value)
  const length = () => JSON.stringify(context).length
  while (length() > MAX_CONTEXT_CHARACTERS && context.recentProgress && context.recentProgress.length > 8) context.recentProgress.pop()
  while (length() > MAX_CONTEXT_CHARACTERS && context.tasks && context.tasks.length > 8) context.tasks.pop()
  const goals = context.goals ?? context.relatedGoals
  while (length() > MAX_CONTEXT_CHARACTERS && goals && goals.length > 4) goals.pop()
  if (length() > MAX_CONTEXT_CHARACTERS) {
    for (const value of context.tasks ?? []) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const task = value as Record<string, unknown>
      delete task.recentHistory
      if (typeof task.details === 'string') task.details = task.details.slice(0, 160)
    }
    for (const value of [context.goal, ...(goals ?? [])]) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const goal = value as Record<string, unknown>
      if (Array.isArray(goal.contextNotes)) goal.contextNotes = goal.contextNotes.slice(-2).map(item => typeof item === 'string' ? item.slice(0, 120) : item)
      if (Array.isArray(goal.unfinishedMilestones)) goal.unfinishedMilestones = goal.unfinishedMilestones.slice(0, 3)
      if (Array.isArray(goal.completedMilestones)) goal.completedMilestones = goal.completedMilestones.slice(-1)
    }
  }
  while (length() > MAX_CONTEXT_CHARACTERS && context.recentProgress?.length) context.recentProgress.pop()
  while (length() > MAX_CONTEXT_CHARACTERS && context.tasks && context.tasks.length > 1) context.tasks.pop()
  while (length() > MAX_CONTEXT_CHARACTERS && goals && goals.length > 1) goals.pop()

  // Independent size trimming must not leave execution records pointing at a
  // goal the model can no longer see. Unlinked Today work remains useful, but
  // linked tasks and progress are kept only when at least one supplied goal
  // relationship survives.
  const allowedGoalIds = new Set([context.goal, ...(goals ?? [])].flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const id = (item as Record<string, unknown>).id
    return typeof id === 'string' && id ? [id] : []
  }))
  if (context.tasks) {
    const coherentTasks = context.tasks.filter(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return true
      const goalId = (item as Record<string, unknown>).goalId
      return typeof goalId !== 'string' || !goalId || allowedGoalIds.has(goalId)
    })
    context.tasks.splice(0, context.tasks.length, ...coherentTasks)
  }
  if (context.recentProgress) {
    const coherentProgress = context.recentProgress.filter(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return true
      const progress = item as Record<string, unknown>
      if (!Array.isArray(progress.goalIds)) return true
      const originalGoalIds = progress.goalIds.filter(id => typeof id === 'string' && Boolean(id)) as string[]
      const goalIds = originalGoalIds.filter(id => allowedGoalIds.has(id))
      progress.goalIds = goalIds
      return originalGoalIds.length === 0 || goalIds.length > 0
    })
    context.recentProgress.splice(0, context.recentProgress.length, ...coherentProgress)
  }
  return context
}

export function buildTodayAiContext(data: AppData, date = todayLocal(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC') {
  const goals = orderedActiveGoals(data).slice(0, 24)
  const goalIds = new Set(goals.map(goal => goal.id))
  return fitContext({
    contextState: 'supplied' as const,
    localDate: date,
    timeZone,
    goals: goals.map(compactGoal),
    tasksState: 'supplied' as const,
    tasks: relevantTasks(data, date, goalIds, true).slice(0, 40).map(compactTask),
    progressState: 'supplied' as const,
    recentProgress: compactProgress(data, goalIds).slice(0, 30),
  })
}

export function buildPlanAiContext(data: AppData, selectedGoal: Goal, date = todayLocal()) {
  const related = orderedActiveGoals(data).filter(goal => goal.id !== selectedGoal.id && (selectedGoal.links.includes(goal.id) || goal.links.includes(selectedGoal.id)))
  const fallbacks = orderedActiveGoals(data).filter(goal => goal.id !== selectedGoal.id && !related.some(item => item.id === goal.id))
  const relatedGoals = [...related, ...fallbacks].slice(0, 16)
  const ids = new Set([selectedGoal.id, ...relatedGoals.map(goal => goal.id)])
  return fitContext({
    contextState: 'supplied' as const,
    localDate: date,
    goal: compactGoal(selectedGoal),
    relatedGoals: relatedGoals.map(compactGoal),
    tasksState: 'supplied' as const,
    tasks: relevantTasks(data, date, ids).slice(0, 30).map(compactTask),
    progressState: 'supplied' as const,
    recentProgress: compactProgress(data, ids).slice(0, 24),
  })
}

export function buildPerspectiveAiContext(data: AppData, period: PeriodRecord) {
  const facts = recapFacts(data, period)
  return {
    contextState: 'supplied' as const,
    facts: {
      period: { kind: period.kind, start: period.start, end: period.end, effectiveStart: period.effectiveStart },
      momentum: facts.momentum,
      momentumStatus: facts.momentumStatus,
      goalMoves: facts.goalMoves,
      activeDays: facts.activeDays,
      evidenceCount: facts.evidenceCount,
      wins: facts.wins.slice(-8).map(item => text(item)),
      milestones: facts.milestones.slice(-8).map(item => text(item)),
      completedGoals: facts.completedGoals.slice(-8).map(item => text(item)),
      numeric: facts.numeric.slice(0, 10).map(item => ({ title: text(item.title), start: item.start, end: item.end, change: item.change, unit: text(item.unit, 32), observations: item.observations, hasComparison: item.hasComparison })),
      strongest: text(facts.strongest, 120),
      needsAttention: text(facts.needsAttention, 120),
    },
  }
}

export const aiContextCharacterCount = (context: unknown) => JSON.stringify(context).length
