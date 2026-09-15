import type { Goal, ProgressEntry, Task } from './domain'
import { compareProgressEntries, localDateOf, recordedDateOf, todayLocal } from './domain'
import { addDays } from './scheduler'
import { progressHistoryId } from './goals'

export interface MomentumResult {
  score: number
  status: 'building' | 'ready'
  eligibleDays: number
  moves: number
  routines: number
  progress: number
  weights: { moves: number; routines: number; progress: number }
  trend: number
  commitments: { moves: number; routines: number }
}

const WINDOW_DAYS = 14
const MIN_READY_DAYS = 3
const baseWeights = { moves: 0.65, routines: 0.25, progress: 0.10 }
const clamp = (value: number) => Math.max(0, Math.min(1, value))

function average(values: number[]) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : undefined
}

function progressDirection(goal: Goal) {
  if (goal.direction) return goal.direction === 'increase' ? 1 : -1
  if (goal.baseline === undefined || goal.target === undefined || goal.baseline === goal.target) return 0
  return goal.target > goal.baseline ? 1 : -1
}

function windowScore(
  tasks: Task[],
  goals: Goal[],
  progress: ProgressEntry[],
  start: string,
  end: string,
  excludeUnstartedEndDay: boolean,
  trackingStartedOn?: string,
) {
  let scoreableTasks = tasks.filter(task =>
    task.dueDate >= start
    && task.dueDate <= end
    && !task.lightDay
    && (task.done || (task.status !== 'excluded' && task.status !== 'deleted'))
    && (task.kind === 'move' || task.kind === 'routine'),
  )

  // A freshly generated morning checklist is not a failed day. Once execution
  // starts, the current day's declared commitments become scoreable.
  if (excludeUnstartedEndDay) {
    const endDay = scoreableTasks.filter(task => task.dueDate === end)
    if (endDay.length && !endDay.some(task => task.done)) {
      scoreableTasks = scoreableTasks.filter(task => task.dueDate !== end)
    }
  }

  const dailyScore = (kind: 'move' | 'routine') => {
    const matching = scoreableTasks.filter(task => task.kind === kind)
    const dates = [...new Set(matching.map(task => task.dueDate))]
    return {
      score: average(dates.map(date => {
        const day = matching.filter(task => task.dueDate === date)
        return day.filter(task => task.done).length / day.length
      })),
      commitments: matching.length,
    }
  }

  const move = dailyScore('move')
  const routine = dailyScore('routine')
  const progressDates = new Set<string>()
  const progressScores: number[] = []

  const eligibleGoals = goals.filter(goal =>
    goal.kind === 'numeric'
    && goal.status !== 'paused'
    && goal.status !== 'closed'
    && goal.baseline !== undefined
    && goal.target !== undefined
    && goal.baseline !== goal.target,
  )
  const histories = [...new Set(eligibleGoals.map(progressHistoryId))]
  for (const historyId of histories) {
    const goal = eligibleGoals
      .filter(item => progressHistoryId(item) === historyId)
      .sort((left, right) => Number(left.status !== 'active') - Number(right.status !== 'active')
        || left.deadline.localeCompare(right.deadline)
        || left.createdAt.localeCompare(right.createdAt))[0]
    if (!goal) continue
    const baseline = goal.baseline
    const target = goal.target
    if (baseline === undefined || target === undefined) continue
    const entries = progress
      .filter(entry => (entry.historyId ?? `measurement:${entry.goalId}`) === historyId
        && recordedDateOf(entry) <= end
        && (!trackingStartedOn || recordedDateOf(entry) >= trackingStartedOn))
      .sort(compareProgressEntries)
    const inWindow = entries.filter(entry => recordedDateOf(entry) >= start)
    if (!inWindow.length) continue
    const beforeWindow = entries.filter(entry => recordedDateOf(entry) < start).at(-1)
    const created = goal.history.find(item => item.action === 'created')
    const createdBaseline = created
      && localDateOf(created.at) >= start
      && localDateOf(created.at) <= end
      ? created.current
      : undefined
    const startValue = beforeWindow?.value ?? createdBaseline ?? (inWindow.length > 1 ? inWindow[0].value : undefined)
    if (startValue === undefined) continue
    const endValue = inWindow.at(-1)!.value
    const direction = progressDirection(goal)
    const targetDistance = Math.abs(target - baseline)
    if (!direction || !targetDistance) continue
    progressScores.push(clamp(((endValue - startValue) * direction) / targetDistance))
    for (const entry of inWindow) progressDates.add(recordedDateOf(entry))
  }

  const progressScore = average(progressScores)
  const components = [
    { key: 'moves' as const, score: move.score, weight: baseWeights.moves },
    { key: 'routines' as const, score: routine.score, weight: baseWeights.routines },
    { key: 'progress' as const, score: progressScore, weight: baseWeights.progress },
  ].filter((component): component is { key: keyof typeof baseWeights; score: number; weight: number } => component.score !== undefined)
  const totalWeight = components.reduce((total, component) => total + component.weight, 0)
  const rawScore = totalWeight
    ? components.reduce((total, component) => total + component.score * component.weight, 0) / totalWeight
    : 0
  const effectiveWeights = { moves: 0, routines: 0, progress: 0 }
  for (const component of components) effectiveWeights[component.key] = component.weight / totalWeight

  const eligibleDates = new Set(scoreableTasks.map(task => task.dueDate))
  for (const date of progressDates) eligibleDates.add(date)
  return {
    score: Math.round(rawScore * 100),
    moves: Math.round((move.score ?? 0) * 100),
    routines: Math.round((routine.score ?? 0) * 100),
    progress: Math.round((progressScore ?? 0) * 100),
    weights: effectiveWeights,
    eligibleDays: eligibleDates.size,
    commitments: { moves: move.commitments, routines: routine.commitments },
    hasData: components.length > 0,
  }
}

export function calculateMomentum(
  tasks: Task[],
  goals: Goal[],
  progress: ProgressEntry[],
  date = todayLocal(),
  options: { includeCurrentDay?: boolean; trackingStartedOn?: string } = {},
): MomentumResult {
  const nominalStart = addDays(date, -(WINDOW_DAYS - 1))
  const start = options.trackingStartedOn && options.trackingStartedOn > nominalStart ? options.trackingStartedOn : nominalStart
  const current = windowScore(tasks, goals, progress, start, date, !options.includeCurrentDay, options.trackingStartedOn)
  const previousEnd = addDays(nominalStart, -1)
  const nominalPreviousStart = addDays(previousEnd, -(WINDOW_DAYS - 1))
  const previousStart = options.trackingStartedOn && options.trackingStartedOn > nominalPreviousStart ? options.trackingStartedOn : nominalPreviousStart
  const previous = windowScore(tasks, goals, progress, previousStart, previousEnd, false, options.trackingStartedOn)
  return {
    score: current.score,
    status: current.eligibleDays >= MIN_READY_DAYS ? 'ready' : 'building',
    eligibleDays: current.eligibleDays,
    moves: current.moves,
    routines: current.routines,
    progress: current.progress,
    weights: current.weights,
    trend: previous.hasData ? current.score - previous.score : 0,
    commitments: current.commitments,
  }
}
