import type {
  AppData,
  Evidence,
  EvidenceKind,
  Goal,
  MeasurementHistory,
  ProgressEntry,
} from './domain'
import { compareProgressEntries, evidenceGoalIds, recordedDateOf } from './domain'
import { evidenceCaptureGroups } from './recap'

export interface MonthBounds {
  key: string
  start: string
  end: string
  label: string
}

export interface ProgressGoalReference {
  goalIds: string[]
  goalTitles: string[]
}

export interface MeasurementPoint {
  id: string
  date: string
  occurredAt: string
  value: number
  note?: string
}

export interface MonthlyMeasurementSummary extends ProgressGoalReference {
  historyId: string
  label: string
  unit?: string
  observationCount: number
  /** Canonical observations inside the selected month, used by its chart. */
  points: MeasurementPoint[]
  first: MeasurementPoint
  latest: MeasurementPoint
  hasComparison: boolean
  change?: number
  comparisonStart?: string
  comparisonEnd?: string
  comparisonLabel?: string
}

export type ProgressFeedEntryKind = 'measurement' | EvidenceKind | 'win'

export interface ProgressFeedEntry extends ProgressGoalReference {
  /** Stable source-qualified key; IDs from different collections may overlap. */
  key: string
  source: 'measurement' | 'evidence' | 'milestone' | 'win'
  sourceId: string
  kind: ProgressFeedEntryKind
  date: string
  occurredAt: string
  title: string
  note?: string
  historyId?: string
  observationId?: string
  value?: number
  unit?: string
  mediaId?: string
  milestoneId?: string
}

export interface UnconfiguredNumericTrackingRow extends ProgressGoalReference {
  historyId: string
  label: string
  unit?: string
  reason: 'missing-history' | 'needs-first-observation'
  targets: Array<{
    goalId: string
    title: string
    horizon: Goal['horizon']
    target?: number
    unit?: string
  }>
}

export interface MonthlyProgressOptions {
  feedOrder?: 'newest-first' | 'oldest-first'
  includeUnconfiguredNumericRows?: boolean
  includeInactiveNumericRows?: boolean
}

export interface MonthlyProgressView {
  month: MonthBounds
  measurementSummaries: MonthlyMeasurementSummary[]
  entries: ProgressFeedEntry[]
  unconfiguredNumericRows: UnconfiguredNumericTrackingRow[]
  isEmpty: boolean
}

const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/
const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const horizonRank = new Map<Goal['horizon'], number>([['1M', 0], ['3M', 1], ['6M', 2], ['1Y', 3], ['2Y', 4]])

function leapYear(year: number) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

function daysInMonth(year: number, month: number) {
  return [31, leapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
}

function validLocalDate(value: string) {
  const match = LOCAL_DATE.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)
}

function dateParts(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  return { year, month, day }
}

function displayMonth(year: number, month: number) {
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year, month - 1, 1)))
}

function displayShortMonthDay(value: string) {
  const { year, month, day } = dateParts(value)
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year, month - 1, day)))
}

export function monthBounds(month: string): MonthBounds {
  const match = MONTH_KEY.exec(month)
  if (!match) throw new RangeError('Month must use YYYY-MM with a real month from 01 through 12.')
  const year = Number(match[1])
  const monthNumber = Number(match[2])
  const lastDay = daysInMonth(year, monthNumber)
  return {
    key: month,
    start: `${month}-01`,
    end: `${month}-${String(lastDay).padStart(2, '0')}`,
    label: displayMonth(year, monthNumber),
  }
}

export function isLocalDateInMonth(value: string, month: string | MonthBounds) {
  if (!validLocalDate(value)) return false
  const bounds = typeof month === 'string' ? monthBounds(month) : month
  return value >= bounds.start && value <= bounds.end
}

export function comparisonPeriodLabel(start: string, end: string) {
  if (!validLocalDate(start) || !validLocalDate(end) || start > end) {
    throw new RangeError('Comparison dates must be valid local dates in chronological order.')
  }
  const startParts = dateParts(start)
  const endParts = dateParts(end)
  if (start === end) return `${displayShortMonthDay(start)}, ${startParts.year} (same day)`
  if (startParts.year === endParts.year && startParts.month === endParts.month) {
    return `${displayShortMonthDay(start)}–${endParts.day}, ${startParts.year}`
  }
  return `${displayShortMonthDay(start)}, ${startParts.year}–${displayShortMonthDay(end)}, ${endParts.year}`
}

function historyMap(data: AppData) {
  return new Map(data.measurementHistories.map(history => [history.id, history]))
}

function resolvedHistoryId(id: string, histories: Map<string, MeasurementHistory>) {
  let current = id
  const visited: string[] = []
  while (!visited.includes(current)) {
    visited.push(current)
    const next = histories.get(current)?.mergedIntoId
    if (!next || !histories.has(next)) return current
    current = next
  }
  // A corrupt merge cycle must still produce a stable grouping key.
  return [...visited].sort()[0]
}

function progressHistoryId(entry: ProgressEntry, goals: Map<string, Goal>, histories: Map<string, MeasurementHistory>) {
  const raw = entry.historyId ?? goals.get(entry.goalId)?.measurementHistoryId ?? `measurement:${entry.goalId}`
  return resolvedHistoryId(raw, histories)
}

function goalHistoryId(goal: Goal, histories: Map<string, MeasurementHistory>) {
  return resolvedHistoryId(goal.measurementHistoryId ?? `measurement:${goal.id}`, histories)
}

function orderedGoals(goals: Goal[]) {
  return [...goals].sort((left, right) =>
    (horizonRank.get(left.horizon) ?? 99) - (horizonRank.get(right.horizon) ?? 99)
    || left.deadline.localeCompare(right.deadline)
    || left.title.localeCompare(right.title)
    || left.id.localeCompare(right.id))
}

function goalReferences(goalIds: Iterable<string>, goals: Map<string, Goal>): ProgressGoalReference {
  const linked = orderedGoals([...new Set(goalIds)].flatMap(id => goals.get(id) ?? []))
  return { goalIds: linked.map(goal => goal.id), goalTitles: linked.map(goal => goal.title) }
}

function goalsForHistory(historyId: string, data: AppData, histories: Map<string, MeasurementHistory>) {
  return data.goals.filter(goal => goal.kind === 'numeric' && goalHistoryId(goal, histories) === historyId)
}

function historyDetails(historyId: string, data: AppData, histories: Map<string, MeasurementHistory>) {
  const history = histories.get(historyId)
  const linked = goalsForHistory(historyId, data, histories)
  const firstGoal = orderedGoals(linked)[0]
  return {
    label: history?.label?.trim() || firstGoal?.title || 'Measurement',
    unit: history?.unit || firstGoal?.unit,
    linked,
  }
}

function point(entry: ProgressEntry): MeasurementPoint {
  return {
    id: entry.id,
    date: recordedDateOf(entry),
    occurredAt: entry.recordedAt,
    value: entry.value,
    note: entry.note?.trim() || undefined,
  }
}

export function buildMonthlyMeasurementSummaries(data: AppData, month: string): MonthlyMeasurementSummary[] {
  const bounds = monthBounds(month)
  const histories = historyMap(data)
  const goals = new Map(data.goals.map(goal => [goal.id, goal]))
  const groupedAsOfMonthEnd = new Map<string, ProgressEntry[]>()

  for (const entry of data.progress) {
    if (!validLocalDate(recordedDateOf(entry)) || recordedDateOf(entry) > bounds.end) continue
    const historyId = progressHistoryId(entry, goals, histories)
    const values = groupedAsOfMonthEnd.get(historyId) ?? []
    // A validated snapshot has unique IDs. This guard keeps the view model
    // one-event-per-observation even for an unsanitized in-memory value.
    if (!values.some(value => value.id === entry.id)) values.push(entry)
    groupedAsOfMonthEnd.set(historyId, values)
  }

  return [...groupedAsOfMonthEnd.entries()].flatMap(([historyId, entries]) => {
    const orderedAsOfMonthEnd = entries.sort(compareProgressEntries)
    const during = orderedAsOfMonthEnd.filter(entry => isLocalDateInMonth(recordedDateOf(entry), bounds))
    const details = historyDetails(historyId, data, histories)
    if (!during.length && !details.linked.some(goal => goal.status === 'active')) return []
    const points = during.map(point)
    const latestAsOfMonthEnd = point(orderedAsOfMonthEnd.at(-1)!)
    const first = points[0] ?? latestAsOfMonthEnd
    const latest = points.at(-1) ?? latestAsOfMonthEnd
    const refs = goalReferences([...details.linked.map(goal => goal.id), ...orderedAsOfMonthEnd.map(entry => entry.goalId)], goals)
    const hasComparison = points.length > 1
    return [{
      historyId,
      label: details.label,
      unit: details.unit,
      ...refs,
      observationCount: points.length,
      points,
      first,
      latest,
      hasComparison,
      change: hasComparison ? latest.value - first.value : undefined,
      comparisonStart: hasComparison ? first.date : undefined,
      comparisonEnd: hasComparison ? latest.date : undefined,
      comparisonLabel: hasComparison ? comparisonPeriodLabel(first.date, latest.date) : undefined,
    }]
  }).sort((left, right) => left.label.localeCompare(right.label) || left.historyId.localeCompare(right.historyId))
}

function evidenceTitle(item: Evidence, goals: Map<string, Goal>) {
  if (item.kind === 'milestone') {
    const milestone = evidenceGoalIds(item).flatMap(id => goals.get(id)?.milestones ?? []).find(value => value.id === item.milestoneId)
    return milestone?.title || item.note?.trim() || 'Milestone'
  }
  const labels: Record<Exclude<EvidenceKind, 'milestone'>, string> = {
    photo: 'Photo evidence',
    screenshot: 'Screenshot evidence',
    number: 'Number update',
    note: 'Progress note',
  }
  return labels[item.kind]
}

function compareFeed(left: ProgressFeedEntry, right: ProgressFeedEntry, order: NonNullable<MonthlyProgressOptions['feedOrder']>) {
  const chronological = left.date.localeCompare(right.date) || left.occurredAt.localeCompare(right.occurredAt)
  if (chronological) return order === 'newest-first' ? -chronological : chronological
  return left.key.localeCompare(right.key)
}

export function buildMonthlyProgressFeed(
  data: AppData,
  month: string,
  order: NonNullable<MonthlyProgressOptions['feedOrder']> = 'newest-first',
): ProgressFeedEntry[] {
  const bounds = monthBounds(month)
  const histories = historyMap(data)
  const goals = new Map(data.goals.map(goal => [goal.id, goal]))
  const observations = new Map(data.progress.map(entry => [entry.id, entry]))
  const evidenceForObservation = new Map<string, Evidence[]>()
  for (const item of data.evidence) {
    if (!item.observationId || !observations.has(item.observationId)) continue
    const values = evidenceForObservation.get(item.observationId) ?? []
    values.push(item)
    evidenceForObservation.set(item.observationId, values)
  }

  const entries = new Map<string, ProgressFeedEntry>()
  for (const item of data.progress) {
    const date = recordedDateOf(item)
    if (!isLocalDateInMonth(date, bounds)) continue
    const historyId = progressHistoryId(item, goals, histories)
    const details = historyDetails(historyId, data, histories)
    const companionEvidence = [...(evidenceForObservation.get(item.id) ?? [])]
      .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt) || left.id.localeCompare(right.id))
    const refs = goalReferences([
      ...details.linked.map(goal => goal.id),
      item.goalId,
      ...companionEvidence.flatMap(evidenceGoalIds),
    ], goals)
    entries.set(`measurement:${item.id}`, {
      key: `measurement:${item.id}`,
      source: 'measurement',
      sourceId: item.id,
      kind: 'measurement',
      date,
      occurredAt: item.recordedAt,
      title: details.label,
      note: item.note?.trim() || companionEvidence.map(value => value.note?.trim()).find(Boolean) || undefined,
      historyId,
      value: item.value,
      unit: details.unit,
      mediaId: companionEvidence.map(value => value.mediaId).find(Boolean),
      ...refs,
    })
  }

  const consumedEvidenceIds = new Set<string>()
  for (const goal of data.goals) {
    for (const milestone of goal.milestones.filter(item => item.done)) {
      const lifecycle = [...goal.history].reverse().find(item =>
        (item.action === 'milestone' || item.action === 'completed')
        && item.note === `Completed milestone: ${milestone.title}`)
      const occurredAt = milestone.completedAt ?? lifecycle?.at
      if (!occurredAt) continue
      const directEvidence = data.evidence.filter(item =>
        item.milestoneId === milestone.id && evidenceGoalIds(item).includes(goal.id))
      // An explicitly shared milestone capture remains one event even if more
      // than one related goal happens to carry a matching milestone shell.
      if (directEvidence.length && directEvidence.every(item => consumedEvidenceIds.has(item.id))) continue
      const mediaIds = new Set(directEvidence.flatMap(item => item.mediaId ? [item.mediaId] : []))
      const relatedEvidence = data.evidence.filter(item =>
        directEvidence.some(candidate => candidate.id === item.id)
        || Boolean(item.mediaId && mediaIds.has(item.mediaId)))
      relatedEvidence.forEach(item => consumedEvidenceIds.add(item.id))
      const date = recordedDateOf({ createdAt: occurredAt })
      if (!isLocalDateInMonth(date, bounds)) continue
      const historyIds = [...new Set(relatedEvidence.flatMap(item => item.historyId
        ? [resolvedHistoryId(item.historyId, histories)]
        : []))]
      const linkedByHistory = historyIds.flatMap(id => goalsForHistory(id, data, histories).map(linked => linked.id))
      const refs = goalReferences([
        goal.id,
        ...relatedEvidence.flatMap(evidenceGoalIds),
        ...linkedByHistory,
      ], goals)
      entries.set(`milestone:${goal.id}:${milestone.id}`, {
        key: `milestone:${goal.id}:${milestone.id}`,
        source: 'milestone',
        sourceId: milestone.id,
        kind: 'milestone',
        date,
        occurredAt,
        title: milestone.title,
        note: relatedEvidence.map(item => item.note?.trim()).find(Boolean),
        historyId: goal.measurementHistoryId,
        mediaId: relatedEvidence.map(item => item.mediaId).find(Boolean),
        milestoneId: milestone.id,
        ...refs,
      })
    }
  }

  const standaloneEvidence = data.evidence.filter(item => {
    // Any evidence explicitly attached to a Progress observation is metadata
    // for that observation, not a second activity in the feed. This applies
    // even when the companion evidence timestamp falls in another month.
    return (!item.observationId || !observations.has(item.observationId))
      && !consumedEvidenceIds.has(item.id)
  })

  for (const group of evidenceCaptureGroups({ evidence: standaloneEvidence })) {
    // Relationship duplicates must not make one physical capture appear in
    // more than one month. Resolve its canonical date across the full group
    // before deciding whether it belongs in this view.
    const { canonical, items: ordered, representative: item } = group
    const date = recordedDateOf(canonical)
    if (!isLocalDateInMonth(date, bounds)) continue
    // If a single image also records a milestone, retain that richer meaning
    // while still rendering the physical capture only once.
    const historyIds = [...new Set(ordered.flatMap(value => value.historyId
      ? [resolvedHistoryId(value.historyId, histories)]
      : []))]
    const historyId = item.historyId ? resolvedHistoryId(item.historyId, histories) : historyIds[0]
    const linkedByHistory = historyIds.flatMap(id => goalsForHistory(id, data, histories).map(goal => goal.id))
    const refs = goalReferences([...group.goalIds, ...linkedByHistory], goals)
    const details = historyId ? historyDetails(historyId, data, histories) : undefined
    const note = [item, ...ordered.filter(value => value !== item)]
      .map(value => value.note?.trim())
      .find(Boolean)
    entries.set(`evidence:${item.id}`, {
      key: `evidence:${item.id}`,
      source: 'evidence',
      sourceId: item.id,
      kind: item.kind,
      date,
      occurredAt: canonical.capturedAt,
      title: evidenceTitle(item, goals),
      note: note || undefined,
      historyId,
      observationId: item.observationId,
      value: [item, ...ordered].map(value => value.value).find(value => value !== undefined),
      unit: details?.unit,
      mediaId: [canonical, item, ...ordered].map(value => value.mediaId).find(Boolean),
      milestoneId: item.milestoneId ?? ordered.map(value => value.milestoneId).find(Boolean),
      ...refs,
    })
  }

  for (const item of data.wins) {
    const date = recordedDateOf(item)
    if (!isLocalDateInMonth(date, bounds)) continue
    entries.set(`win:${item.id}`, {
      key: `win:${item.id}`,
      source: 'win',
      sourceId: item.id,
      kind: 'win',
      date,
      occurredAt: item.createdAt,
      title: item.title.trim() || 'Win',
      note: item.note?.trim() || undefined,
      mediaId: item.mediaId,
      ...goalReferences(evidenceGoalIds(item), goals),
    })
  }

  return [...entries.values()].sort((left, right) => compareFeed(left, right, order))
}

export function buildUnconfiguredNumericRows(
  data: AppData,
  options: { includeInactive?: boolean } = {},
): UnconfiguredNumericTrackingRow[] {
  const histories = historyMap(data)
  const goalsById = new Map(data.goals.map(goal => [goal.id, goal]))
  const numeric = data.goals.filter(goal => goal.kind === 'numeric'
    && (options.includeInactive || goal.status === 'active'))
  const groups = new Map<string, Goal[]>()
  for (const goal of numeric) {
    const historyId = goalHistoryId(goal, histories)
    const values = groups.get(historyId) ?? []
    values.push(goal)
    groups.set(historyId, values)
  }

  const configuredHistoryIds = new Set(data.progress.map(entry => progressHistoryId(entry, goalsById, histories)))
  return [...groups.entries()].flatMap(([historyId, linked]) => {
    if (configuredHistoryIds.has(historyId)) return []
    const ordered = orderedGoals(linked)
    const history = histories.get(historyId)
    return [{
      historyId,
      label: history?.label?.trim() || ordered[0]?.title || 'Measurement',
      unit: history?.unit || ordered.find(goal => goal.unit)?.unit,
      reason: ordered.some(goal => !goal.measurementHistoryId || !histories.has(goal.measurementHistoryId)) ? 'missing-history' as const : 'needs-first-observation' as const,
      ...goalReferences(ordered.map(goal => goal.id), goalsById),
      targets: ordered.map(goal => ({ goalId: goal.id, title: goal.title, horizon: goal.horizon, target: goal.target, unit: goal.unit })),
    }]
  }).sort((left, right) => left.label.localeCompare(right.label) || left.historyId.localeCompare(right.historyId))
}

export function buildMonthlyProgressView(
  data: AppData,
  month: string,
  options: MonthlyProgressOptions = {},
): MonthlyProgressView {
  const measurementSummaries = buildMonthlyMeasurementSummaries(data, month)
  const entries = buildMonthlyProgressFeed(data, month, options.feedOrder)
  return {
    month: monthBounds(month),
    measurementSummaries,
    entries,
    unconfiguredNumericRows: options.includeUnconfiguredNumericRows
      ? buildUnconfiguredNumericRows(data, { includeInactive: options.includeInactiveNumericRows })
      : [],
    isEmpty: entries.length === 0,
  }
}
