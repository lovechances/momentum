import type { AppData, PeriodRecord } from './domain'
import { compareProgressEntries, localDateOf, recordedDateOf } from './domain'
import { calculateMomentum } from './momentum'
import { progressHistoryId } from './goals'
import { evidenceCaptureGroups } from './evidence-captures'

export { compareEvidenceCaptures, evidenceCaptureGroups, evidenceCaptureKey } from './evidence-captures'

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
    historyId: string
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

const inPeriod = (value: string, period: PeriodRecord) => value >= (period.effectiveStart ?? period.start) && value <= period.end

export function isMeaningfulRecap(data: AppData, period: PeriodRecord) {
  if (period.end < data.planning.trackingStartedOn) return false
  const scopedPeriod = { ...period, effectiveStart: [period.effectiveStart ?? period.start, data.planning.trackingStartedOn].sort().at(-1)! }
  return data.tasks.some(task => (task.done || (task.status !== 'excluded' && task.status !== 'deleted')) && inPeriod(task.dueDate, scopedPeriod) && (task.kind !== 'routine' || task.done))
    || data.progress.some(item => inPeriod(recordedDateOf(item), scopedPeriod))
    || evidenceCaptureGroups(data).some(capture => inPeriod(recordedDateOf(capture.canonical), scopedPeriod))
    || data.wins.some(item => inPeriod(recordedDateOf(item), scopedPeriod))
    || data.goals.some(goal => goal.history.some(item => item.action !== 'created' && inPeriod(item.effectiveOn ?? localDateOf(item.at), scopedPeriod)))
}

export function recapFacts(data: AppData, period: PeriodRecord): RecapFacts {
  const periodStart = [period.effectiveStart ?? period.start, data.planning.trackingStartedOn].sort().at(-1)!
  const scopedPeriod = { ...period, effectiveStart: periodStart }
  const tasks = data.tasks.filter(task => inPeriod(task.dueDate, scopedPeriod) && !task.lightDay && (task.done || (task.status !== 'excluded' && task.status !== 'deleted')))
  const moves = tasks.filter(task => task.kind === 'move')
  const numericGoals = data.goals.filter(goal => goal.kind === 'numeric')
  const numeric = [...new Set(numericGoals.map(progressHistoryId))].flatMap(historyId => {
    const linkedGoals = numericGoals.filter(goal => progressHistoryId(goal) === historyId)
    const goal = [...linkedGoals].sort((left, right) => left.deadline.localeCompare(right.deadline) || left.createdAt.localeCompare(right.createdAt))[0]
    if (!goal) return []
    const entries = data.progress
      .filter(entry => (entry.historyId ?? `measurement:${entry.goalId}`) === historyId
        && recordedDateOf(entry) <= period.end
        && (!period.effectiveStart || recordedDateOf(entry) >= periodStart))
      .sort(compareProgressEntries)
    const during = entries.filter(entry => recordedDateOf(entry) >= periodStart)
    if (!during.length) return []

    const before = entries.filter(entry => recordedDateOf(entry) < periodStart).at(-1)
    const created = goal.history.find(item => item.action === 'created')
    const originalBaseline = created?.current
    const baselineAvailable = created !== undefined
      && originalBaseline !== undefined
      && localDateOf(created.at) <= period.end
      && localDateOf(created.at) >= periodStart
    const start = before?.value ?? (baselineAvailable ? originalBaseline : during[0].value)
    const end = during.at(-1)!.value
    return [{
      goalId: goal.id,
      historyId,
      title: data.measurementHistories.find(history => history.id === historyId)?.label ?? goal.title,
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
    .filter(win => inPeriod(recordedDateOf(win), scopedPeriod))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(win => win.title)
  const captures = evidenceCaptureGroups(data)
  const milestones = [...new Set([
    ...captures
      .filter(capture => inPeriod(recordedDateOf(capture.canonical), scopedPeriod))
      .flatMap(capture => capture.items.filter(item => item.kind === 'milestone').slice(0, 1))
      .map(item => item.note?.trim() || data.goals.find(goal => goal.id === item.goalId)?.milestones.find(milestone => milestone.id === item.milestoneId)?.title),
    ...data.goals.flatMap(goal => goal.history
      .filter(item => inPeriod(item.effectiveOn ?? localDateOf(item.at), scopedPeriod) && item.note?.startsWith('Completed milestone: '))
      .map(item => item.note!.slice('Completed milestone: '.length).trim())),
  ].filter((value): value is string => Boolean(value)))]
  const completedGoals = data.goals.flatMap(goal => {
    let completionIndex = -1
    goal.history.forEach((item, index) => {
      if (item.action === 'completed' && inPeriod(item.effectiveOn ?? localDateOf(item.at), scopedPeriod)) completionIndex = index
    })
    if (completionIndex < 0) return []
    const reopenedBeforePeriodEnd = goal.history.slice(completionIndex + 1).some(item =>
      item.action === 'reopened' && (item.effectiveOn ?? localDateOf(item.at)) <= period.end,
    )
    return reopenedBeforePeriodEnd ? [] : [goal.title]
  })

  const momentum = calculateMomentum(tasks, data.goals, data.progress, period.end, { includeCurrentDay: true, trackingStartedOn: periodStart, reviewedDays: data.planning.reviewedDays })
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
    evidenceCount: captures.filter(capture => inPeriod(recordedDateOf(capture.canonical), scopedPeriod)).length,
    strongest,
    needsAttention,
  }
}

/** Select only facts with a story; images remain attached to the fact they prove. */
export function recapStorySelection(data: AppData, facts: RecapFacts) {
  const start = [facts.period.effectiveStart ?? facts.period.start, data.planning.trackingStartedOn].sort().at(-1)!
  const numeric = facts.numeric.filter(item => item.hasComparison && item.change !== 0)
    .sort((a, b) => Math.abs(b.change / (b.start || 1)) - Math.abs(a.change / (a.start || 1)) || a.historyId.localeCompare(b.historyId))
  const mediaForHistory = (historyId: string) => evidenceCaptureGroups(data)
    .filter(group => recordedDateOf(group.canonical) >= start && recordedDateOf(group.canonical) <= facts.period.end
      && group.items.some(item => item.historyId === historyId))
    .flatMap(group => group.items.flatMap(item => item.mediaId ? [{ mediaId: item.mediaId, alt: item.note?.trim() || `${item.kind} evidence` }] : []))[0]
  return { numeric: numeric.map(item => ({ ...item, evidence: mediaForHistory(item.historyId) })), completedGoals: facts.completedGoals, milestones: facts.milestones, wins: facts.wins }
}
