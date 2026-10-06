import type { AppData, Goal, Horizon, Task } from './domain'
import { localDateOf, now, recordedDateOf, todayLocal } from './domain'
import { completeGoal, completeGoalForPeriod, isDeadlineReviewDue } from './goals'
import { addDays, addMonths, dateAtLocalMidnight, generateRoutineTasks, periodFor, startOfMonth } from './scheduler'

const horizons: Horizon[] = ['1M', '3M', '6M', '1Y', '2Y']
const periodKind = { '1M': 'month', '3M': '3M', '6M': '6M', '1Y': 'year', '2Y': 'year' } as const

export function completionDay(goal: Goal) {
  return [...goal.history].reverse().find(event => event.action === 'completed')?.effectiveOn
    ?? localDateOf([...goal.history].reverse().find(event => event.action === 'completed')?.at ?? goal.createdAt)
}

export function goalPresentation(data: AppData, horizon: Horizon, date = todayLocal()) {
  const cycle = periodFor(periodKind[horizon], date, data.planning.anchorMonth)
  const cycleStart = horizon === '2Y' ? (() => {
    const [year, month] = date.split('-').map(Number)
    const [anchorYear, anchorMonth] = data.planning.anchorMonth.split('-').map(Number)
    const elapsed = (year - anchorYear) * 12 + month - anchorMonth
    return addMonths(data.planning.anchorMonth, Math.floor(elapsed / 24) * 24)
  })() : cycle.start
  const goals = data.goals.filter(goal => goal.horizon === horizon)
  const current = goals.filter(goal => goal.status !== 'closed' && (goal.status !== 'completed' || completionDay(goal) >= cycleStart))
    .sort((a, b) => Number(a.status === 'completed') - Number(b.status === 'completed') || a.deadline.localeCompare(b.deadline) || a.createdAt.localeCompare(b.createdAt))
  const historical = goals.filter(goal => goal.status === 'closed' || (goal.status === 'completed' && completionDay(goal) < cycleStart))
  return { current, historical }
}

/** Surface the adjacent longer horizon when its deadline enters this horizon's planning window. */
export function horizonPlanningCandidates(data: AppData, horizon: Horizon, date = todayLocal()) {
  const index = horizons.indexOf(horizon)
  if (index < 0 || index === horizons.length - 1) return []
  const from = startOfMonth(date)
  const windowEnd = periodFor(periodKind[horizon], date, data.planning.anchorMonth).end
  const shorter = data.goals.filter(goal => goal.horizon === horizon && goal.status === 'active')
  return data.goals.filter(goal => goal.horizon === horizons[index + 1]
    && goal.status === 'active' && goal.deadline >= from && goal.deadline <= addDays(windowEnd, 1))
    .map(goal => ({ goal, support: shorter.filter(item => item.links.includes(goal.id) || goal.links.includes(item.id)) }))
    .sort((a, b) => a.goal.deadline.localeCompare(b.goal.deadline) || a.goal.id.localeCompare(b.goal.id))
}

export function newPeriodPlanningDue(data: AppData, date = todayLocal()) {
  const month = startOfMonth(date)
  return month > startOfMonth(data.planning.trackingStartedOn)
    && (data.planning.openedMonth ?? startOfMonth(data.planning.trackingStartedOn)) < month
    && !data.goals.some(goal => isDeadlineReviewDue(goal, date))
}

export function completeReviewedGoal(data: AppData, id: string, at = now()): AppData {
  const goal = data.goals.find(item => item.id === id)
  if (!goal || !isDeadlineReviewDue(goal, localDateOf(at))) return data
  const endingDay = goal.deadline.endsWith('-01') && localDateOf(goal.createdAt) < goal.deadline
    ? addDays(goal.deadline, -1) : goal.deadline
  return { ...data, goals: data.goals.map(item => item.id === id
    ? endingDay === localDateOf(at) ? completeGoal(item, at, 'Confirmed during deadline review') : completeGoalForPeriod(item, endingDay, at)
    : item) }
}

/** The end of the selected day must still be within the last 72 hours. */
export function canCompletePastDay(day: string, at = now()) {
  const today = localDateOf(at)
  if (day >= today || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false
  const nextDay = dateAtLocalMidnight(addDays(day, 1)).getTime()
  return nextDay > new Date(at).getTime() - 72 * 60 * 60 * 1000
}

export function completeTaskForPastDay(data: AppData, id: string, day: string, at = now()): AppData {
  const existing = data.tasks.find(item => item.id === id)
  const task = existing ?? generateRoutineTasks(data.routines, data.tasks, day, data.routineExclusions).find(item => item.id === id)
  if (!task || task.dueDate !== day || task.done || !canCompletePastDay(day, at)
    || ['deleted', 'excluded', 'rolled', 'dropped'].includes(task.status ?? 'active')) return data
  const completed = { ...task, createdAt: existing ? task.createdAt : at, done: true, completedOn: day, resolvedAt: at,
    history: [...(task.history ?? []), { at, effectiveOn: day, action: 'completed' as const }] }
  return { ...data, tasks: existing ? data.tasks.map(item => item.id === id ? completed : item) : [...data.tasks, completed] }
}

export function confirmMissedDay(data: AppData, day: string, at = now()): AppData {
  if (!canCompletePastDay(day, at) || data.planning.reviewedDays?.some(item => item.date === day)
    || data.tasks.some(item => item.dueDate === day && item.done)
    || data.progress.some(item => recordedDateOf(item) === day)) return data
  return { ...data, planning: { ...data.planning, reviewedDays: [...(data.planning.reviewedDays ?? []), { date: day, recordedAt: at, result: 'missed' }] } }
}
