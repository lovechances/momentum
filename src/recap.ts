import type { AppData, PeriodRecord } from './domain'
import { localDateOf } from './domain'
import { calculateMomentum } from './momentum'

export interface RecapFacts {
  period: PeriodRecord
  momentum: number
  momentumStatus: 'building' | 'ready'
  goalMoves: { done: number; due: number }
  activeDays: number
  wins: string[]
  milestones: string[]
  numeric: {
    goalId: string
    title: string
    start: number
    end: number
    change: number
    unit?: string
    observations: number
    hasComparison: boolean
  }[]
  completedGoals: string[]
  evidenceCount: number
  strongest: string
  needsAttention: string
}

const inPeriod = (value: string, period: PeriodRecord) => value >= period.start && value <= period.end

export function isMeaningfulRecap(data: AppData, period: PeriodRecord) {
  return data.tasks.some(task => inPeriod(task.dueDate, period) && (task.kind !== 'routine' || task.done))
    || data.progress.some(item => inPeriod(localDateOf(item.recordedAt), period))
    || data.evidence.some(item => inPeriod(localDateOf(item.capturedAt), period))
    || data.wins.some(item => inPeriod(localDateOf(item.createdAt), period))
    || data.goals.some(goal => goal.history.some(item => item.action !== 'created' && inPeriod(localDateOf(item.at), period)))
}

export function recapFacts(data: AppData, period: PeriodRecord): RecapFacts {
  const tasks = data.tasks.filter(task => inPeriod(task.dueDate, period) && !task.lightDay)
  const moves = tasks.filter(task => task.kind === 'move')
  const numeric = data.goals.filter(goal => goal.kind === 'numeric').flatMap(goal => {
    const entries = data.progress
      .filter(entry => entry.goalId === goal.id && localDateOf(entry.recordedAt) <= period.end)
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
    const during = entries.filter(entry => localDateOf(entry.recordedAt) >= period.start)
    if (!during.length) return []

    const before = entries.filter(entry => localDateOf(entry.recordedAt) < period.start).at(-1)
    const created = goal.history.find(item => item.action === 'created')
    const originalBaseline = created?.current
    const baselineAvailable = created !== undefined && originalBaseline !== undefined && localDateOf(created.at) <= period.end
    const start = before?.value ?? (baselineAvailable ? originalBaseline : during[0].value)
    const end = during.at(-1)!.value
    return [{
      goalId: goal.id,
      title: goal.title,
      start,
      end,
      change: end - start,
      unit: goal.unit,
      observations: during.length,
      hasComparison: before !== undefined || baselineAvailable || during.length > 1,
    }]
  })

  const areaRates = data.settings.areas.flatMap(area => {
    const areaMoves = moves.filter(move => data.goals.find(goal => goal.id === move.goalId)?.area === area)
    return areaMoves.length ? [{ area, rate: areaMoves.filter(move => move.done).length / areaMoves.length }] : []
  })
  const maxRate = areaRates.length ? Math.max(...areaRates.map(item => item.rate)) : undefined
  const minRate = areaRates.length ? Math.min(...areaRates.map(item => item.rate)) : undefined
  const strongest = maxRate === undefined
    ? '—'
    : areaRates.filter(item => item.rate === maxRate).map(item => item.area).sort().join(' + ')
  const needsAttention = minRate !== undefined && maxRate !== undefined && minRate < maxRate
    ? areaRates.filter(item => item.rate === minRate).map(item => item.area).sort().join(' + ')
    : '—'

  const wins = data.wins
    .filter(win => inPeriod(localDateOf(win.createdAt), period))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(win => win.title)
  const milestones = [...new Set([
    ...data.evidence
      .filter(item => item.kind === 'milestone' && inPeriod(localDateOf(item.capturedAt), period))
      .map(item => item.note?.trim() || data.goals.find(goal => goal.id === item.goalId)?.milestones.find(milestone => milestone.id === item.milestoneId)?.title),
    ...data.goals.flatMap(goal => goal.history
      .filter(item => inPeriod(localDateOf(item.at), period) && item.note?.startsWith('Completed milestone: '))
      .map(item => item.note!.slice('Completed milestone: '.length).trim())),
  ].filter((value): value is string => Boolean(value)))]
  const completedGoals = data.goals.flatMap(goal => {
    let completionIndex = -1
    goal.history.forEach((item, index) => {
      if (item.action === 'completed' && inPeriod(localDateOf(item.at), period)) completionIndex = index
    })
    if (completionIndex < 0) return []
    const reopenedBeforePeriodEnd = goal.history.slice(completionIndex + 1).some(item =>
      item.action === 'reopened' && localDateOf(item.at) <= period.end,
    )
    return reopenedBeforePeriodEnd ? [] : [goal.title]
  })

  const momentum = calculateMomentum(tasks, data.goals, data.progress, period.end, { includeCurrentDay: true })
  return {
    period,
    momentum: momentum.score,
    momentumStatus: momentum.status,
    goalMoves: { done: moves.filter(task => task.done).length, due: moves.length },
    activeDays: new Set(tasks.filter(task => task.done).map(task => task.dueDate)).size,
    wins,
    milestones,
    numeric,
    completedGoals,
    evidenceCount: data.evidence.filter(item => inPeriod(localDateOf(item.capturedAt), period)).length,
    strongest,
    needsAttention,
  }
}
