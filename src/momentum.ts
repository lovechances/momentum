import type { Goal, ProgressEntry, Task } from './domain'
import { localDateOf, todayLocal } from './domain'
import { addDays } from './scheduler'

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
) {
  let scoreableTasks = tasks.filter(task =>
    task.dueDate >= start
    && task.dueDate <= end
    && !task.lightDay
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

  for (const goal of goals.filter(goal =>
    goal.kind === 'numeric'
    && goal.status !== 'paused'
    && goal.status !== 'closed'
    && goal.baseline !== undefined
    && goal.target !== undefined
    && goal.baseline !== goal.target,
  )) {
    const baseline = goal.baseline
    const target = goal.target
    if (baseline === undefined || target === undefined) continue
    const entries = progress
      .filter(entry => entry.goalId === goal.id && localDateOf(entry.recordedAt) <= end)
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
    const inWindow = entries.filter(entry => localDateOf(entry.recordedAt) >= start)
    if (!inWindow.length) continue
    const beforeWindow = entries.filter(entry => localDateOf(entry.recordedAt) < start).at(-1)
    const createdBaseline = goal.history.find(item => item.action === 'created')?.current
    const startValue = beforeWindow?.value ?? createdBaseline ?? (inWindow.length > 1 ? inWindow[0].value : undefined)
    if (startValue === undefined) continue
    const endValue = inWindow.at(-1)!.value
    const direction = progressDirection(goal)
    const targetDistance = Math.abs(target - baseline)
    if (!direction || !targetDistance) continue
    progressScores.push(clamp(((endValue - startValue) * direction) / targetDistance))
    for (const entry of inWindow) progressDates.add(localDateOf(entry.recordedAt))
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
  options: { includeCurrentDay?: boolean } = {},
): MomentumResult {
  const start = addDays(date, -(WINDOW_DAYS - 1))
  const current = windowScore(tasks, goals, progress, start, date, !options.includeCurrentDay)
  const previousEnd = addDays(start, -1)
  const previousStart = addDays(previousEnd, -(WINDOW_DAYS - 1))
  const previous = windowScore(tasks, goals, progress, previousStart, previousEnd, false)
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
