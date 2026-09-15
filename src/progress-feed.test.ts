import { describe, expect, it } from 'vitest'
import type { AppData, Evidence, Goal, MeasurementHistory, ProgressEntry, Win } from './domain'
import { createInitialData } from './seed'
import {
  buildMonthlyMeasurementSummaries,
  buildMonthlyProgressFeed,
  buildMonthlyProgressView,
  buildUnconfiguredNumericRows,
  comparisonPeriodLabel,
  isLocalDateInMonth,
  monthBounds,
} from './progress-feed'

const at = '2026-09-15T12:00:00.000Z'

function numericGoal(id: string, title: string, historyId: string, patch: Partial<Goal> = {}): Goal {
  return {
    id,
    title,
    horizon: '1M',
    kind: 'numeric',
    area: 'Body',
    target: 100,
    unit: 'lbs',
    deadline: '2026-10-01',
    measurementHistoryId: historyId,
    status: 'active',
    color: 'lime',
    milestones: [],
    links: [],
    history: [{ at, action: 'created', target: 100, deadline: '2026-10-01' }],
    evidenceSchedules: [],
    createdAt: at,
    ...patch,
  }
}

function fixture(goals: Goal[], histories: MeasurementHistory[]): AppData {
  const initial = createInitialData(new Date(at))
  return {
    ...initial,
    goals,
    measurementHistories: histories,
    progressLinkSuggestions: [],
    tasks: [],
    evidence: [],
    wins: [],
    progress: [],
    routineExclusions: [],
    reminderOccurrences: [],
    periods: [],
    onboarded: true,
  }
}

const observation = (id: string, goalId: string, historyId: string, date: string, value: number): ProgressEntry => ({
  id,
  goalId,
  historyId,
  value,
  recordedAt: `${date}T12:00:00.000Z`,
  recordedOn: date,
})

describe('monthly Progress view model', () => {
  it('builds one honest summary for each shared weight and savings history while keeping online income separate', () => {
    const weightGoals = [
      numericGoal('weight-1m', '140 lbs clean', 'weight', { target: 140 }),
      numericGoal('weight-6m', '170 lbs clean', 'weight', { horizon: '6M', target: 170, deadline: '2027-03-01' }),
    ]
    const savingsGoals = [
      numericGoal('save-1m', '$7k stacked', 'savings', { area: 'Money', unit: 'USD', target: 7_000 }),
      numericGoal('save-6m', '$20k stacked', 'savings', { area: 'Money', unit: 'USD', horizon: '6M', target: 20_000, deadline: '2027-03-01' }),
    ]
    const income = numericGoal('income', '$5k/mo+ online', 'online-income', { area: 'Business', unit: 'USD', horizon: '1Y', target: 5_000, deadline: '2027-09-01' })
    const data = fixture([...weightGoals, ...savingsGoals, income], [
      { id: 'weight', label: 'Weight', unit: 'lbs', semanticKey: 'body-weight', createdAt: at },
      { id: 'savings', label: 'Savings', unit: 'USD', semanticKey: 'savings-balance', createdAt: at },
      { id: 'online-income', label: 'Online income', unit: 'USD/month', createdAt: at },
    ])
    data.progress = [
      observation('weight-before', 'weight-1m', 'weight', '2026-08-31', 148),
      observation('weight-first', 'weight-1m', 'weight', '2026-09-02', 150),
      observation('weight-last', 'weight-6m', 'weight', '2026-09-28', 154),
      observation('savings-before', 'save-1m', 'savings', '2026-08-31', 6_000),
      observation('savings-first', 'save-1m', 'savings', '2026-09-01', 6_500),
      observation('savings-last', 'save-6m', 'savings', '2026-09-30', 7_200),
      observation('income-only', 'income', 'online-income', '2026-09-10', 1_200),
      observation('savings-after', 'save-6m', 'savings', '2026-10-01', 7_300),
    ]
    data.evidence = [
      {
        id: 'weight-number-evidence',
        goalId: 'weight-1m',
        goalIds: ['weight-1m', 'weight-6m'],
        historyId: 'weight',
        observationId: 'weight-last',
        kind: 'number',
        value: 154,
        capturedAt: '2026-09-28T12:00:01.000Z',
        recordedOn: '2026-09-28',
      },
      {
        id: 'weight-photo-companion',
        goalId: 'weight-1m',
        goalIds: ['weight-1m', 'weight-6m'],
        historyId: 'weight',
        observationId: 'weight-last',
        kind: 'photo',
        note: 'Scale receipt',
        mediaId: 'scale-photo',
        capturedAt: '2026-09-28T12:00:02.000Z',
        recordedOn: '2026-09-28',
      },
    ]

    const summaries = buildMonthlyMeasurementSummaries(data, '2026-09')
    expect(summaries).toHaveLength(3)
    expect(summaries.filter(item => item.historyId === 'weight')).toHaveLength(1)
    expect(summaries.find(item => item.historyId === 'weight')).toMatchObject({
      goalIds: ['weight-1m', 'weight-6m'],
      observationCount: 2,
      points: [
        expect.objectContaining({ id: 'weight-first', value: 150 }),
        expect.objectContaining({ id: 'weight-last', value: 154 }),
      ],
      change: 4,
      hasComparison: true,
      comparisonLabel: 'Sep 2–28, 2026',
    })
    expect(summaries.find(item => item.historyId === 'savings')).toMatchObject({
      goalIds: ['save-1m', 'save-6m'],
      observationCount: 2,
      change: 700,
      comparisonLabel: 'Sep 1–30, 2026',
    })
    expect(summaries.find(item => item.historyId === 'online-income')).toMatchObject({
      label: 'Online income',
      observationCount: 1,
      hasComparison: false,
    })
    expect(summaries.find(item => item.historyId === 'online-income')?.change).toBeUndefined()

    const feed = buildMonthlyProgressFeed(data, '2026-09', 'oldest-first')
    expect(feed).toHaveLength(5)
    expect(feed.filter(item => item.sourceId === 'weight-last')).toHaveLength(1)
    expect(feed.some(item => item.sourceId === 'weight-number-evidence')).toBe(false)
    expect(feed.some(item => item.sourceId === 'weight-photo-companion')).toBe(false)
    expect(feed.find(item => item.sourceId === 'weight-last')).toMatchObject({
      goalTitles: ['140 lbs clean', '170 lbs clean'],
      note: 'Scale receipt',
      mediaId: 'scale-photo',
    })
    expect(feed.filter(item => item.historyId === 'online-income')).toHaveLength(1)
  })

  it('carries the last known value across quiet months without inventing a monthly trend or leaking future values', () => {
    const goal = numericGoal('weight', 'Weight', 'weight')
    const data = fixture([goal], [{ id: 'weight', label: 'Weight', unit: 'lbs', createdAt: at }])
    data.progress = [
      observation('august', goal.id, 'weight', '2026-08-28', 146),
      observation('future', goal.id, 'weight', '2026-11-01', 151),
    ]

    expect(buildMonthlyMeasurementSummaries(data, '2026-10')).toEqual([
      expect.objectContaining({
        historyId: 'weight',
        observationCount: 0,
        points: [],
        latest: expect.objectContaining({ id: 'august', date: '2026-08-28', value: 146 }),
        hasComparison: false,
        change: undefined,
        comparisonLabel: undefined,
      }),
    ])
    expect(buildMonthlyProgressView(data, '2026-10').isEmpty).toBe(true)
  })

  it('provides canonical month points for legacy and merged-history observations', () => {
    const goal = numericGoal('weight', 'Weight', 'canonical')
    const data = fixture([goal], [
      { id: 'legacy', label: 'Old Weight', unit: 'lbs', createdAt: at, mergedIntoId: 'canonical' },
      { id: 'canonical', label: 'Weight', unit: 'lbs', createdAt: at },
    ])
    data.progress = [
      { ...observation('missing-id', goal.id, 'canonical', '2026-09-02', 145), historyId: undefined },
      observation('merged-id', goal.id, 'legacy', '2026-09-20', 147),
    ]

    const summary = buildMonthlyMeasurementSummaries(data, '2026-09')[0]
    expect(summary.historyId).toBe('canonical')
    expect(summary.points.map(item => item.id)).toEqual(['missing-id', 'merged-id'])
    expect(summary.observationCount).toBe(2)
    expect(summary.change).toBe(2)
  })

  it('emits one feed entry for linked photo, milestone, and win records instead of copying them per goal', () => {
    const first = numericGoal('first', 'First goal', 'shared')
    const second = numericGoal('second', 'Second goal', 'shared', { horizon: '3M', deadline: '2026-12-01' })
    second.milestones = [{ id: 'checkpoint', title: 'Shared checkpoint', done: true, completedAt: '2026-09-05T12:00:00.000Z' }]
    const data = fixture([first, second], [{ id: 'shared', label: 'Shared metric', unit: 'lbs', createdAt: at }])
    const evidence: Evidence[] = [
      { id: 'photo', goalId: 'first', goalIds: ['first', 'second'], kind: 'photo', note: 'Front view', mediaId: 'photo-media', capturedAt: '2026-09-04T12:00:00.000Z', recordedOn: '2026-09-04' },
      { id: 'milestone', goalId: 'first', goalIds: ['first', 'second'], kind: 'milestone', milestoneId: 'checkpoint', capturedAt: '2026-09-05T12:00:00.000Z', recordedOn: '2026-09-05' },
    ]
    const wins: Win[] = [{ id: 'win', title: 'A shared win', goalId: 'first', goalIds: ['first', 'second'], createdAt: '2026-09-06T12:00:00.000Z', recordedOn: '2026-09-06' }]
    data.evidence = evidence
    data.wins = wins

    const feed = buildMonthlyProgressFeed(data, '2026-09', 'oldest-first')
    expect(feed.map(item => item.key)).toEqual(['evidence:photo', 'milestone:second:checkpoint', 'win:win'])
    expect(feed.every(item => item.goalIds.length === 2)).toBe(true)
    expect(feed.every(item => item.goalTitles.join('|') === 'First goal|Second goal')).toBe(true)
    expect(feed.find(item => item.key === 'milestone:second:checkpoint')?.title).toBe('Shared checkpoint')
  })

  it('folds legacy evidence rows sharing one image into one feed entry with every goal relationship', () => {
    const first = numericGoal('first', 'First goal', 'first-history')
    const second = numericGoal('second', 'Second goal', 'second-history', { horizon: '3M', deadline: '2026-12-01' })
    const data = fixture([first, second], [
      { id: 'first-history', label: 'First metric', unit: 'lbs', createdAt: at },
      { id: 'second-history', label: 'Second metric', unit: 'lbs', createdAt: at },
    ])
    data.evidence = [
      { id: 'photo-first', goalId: first.id, historyId: 'first-history', kind: 'photo', note: 'One physical capture', mediaId: 'shared-local-image', capturedAt: '2026-09-08T12:00:00.000Z', recordedOn: '2026-09-08' },
      { id: 'photo-second', goalId: second.id, historyId: 'second-history', kind: 'photo', mediaId: 'shared-local-image', capturedAt: '2026-09-08T12:00:01.000Z', recordedOn: '2026-09-08' },
    ]

    const feed = buildMonthlyProgressFeed(data, '2026-09', 'oldest-first')
    expect(feed).toHaveLength(1)
    expect(feed[0]).toMatchObject({
      key: 'evidence:photo-first',
      sourceId: 'photo-first',
      mediaId: 'shared-local-image',
      note: 'One physical capture',
      goalIds: ['first', 'second'],
      goalTitles: ['First goal', 'Second goal'],
    })
  })

  it('assigns one shared image to one canonical month even when legacy relationship dates disagree', () => {
    const first = numericGoal('first', 'First goal', 'first-history')
    const second = numericGoal('second', 'Second goal', 'second-history')
    const data = fixture([first, second], [
      { id: 'first-history', label: 'First metric', createdAt: at },
      { id: 'second-history', label: 'Second metric', createdAt: at },
    ])
    data.evidence = [
      { id: 'august-copy', goalId: first.id, kind: 'photo', mediaId: 'one-image', capturedAt: '2026-08-31T23:59:00.000Z', recordedOn: '2026-08-31' },
      { id: 'september-copy', goalId: second.id, kind: 'photo', mediaId: 'one-image', capturedAt: '2026-09-01T00:01:00.000Z', recordedOn: '2026-09-01' },
    ]

    expect(buildMonthlyProgressFeed(data, '2026-08')).toHaveLength(1)
    expect(buildMonthlyProgressFeed(data, '2026-09')).toHaveLength(0)
  })

  it('keeps milestone meaning when a photo and milestone share one physical image', () => {
    const first = numericGoal('first', 'First goal', 'first-history')
    const second = numericGoal('second', 'Second goal', 'second-history')
    second.milestones = [{ id: 'checkpoint', title: 'Visible checkpoint', done: true }]
    const data = fixture([first, second], [
      { id: 'first-history', label: 'First metric', createdAt: at },
      { id: 'second-history', label: 'Second metric', createdAt: at },
    ])
    data.evidence = [
      { id: 'photo', goalId: first.id, kind: 'photo', mediaId: 'one-image', capturedAt: '2026-09-08T12:00:00.000Z', recordedOn: '2026-09-08' },
      { id: 'milestone', goalId: second.id, kind: 'milestone', milestoneId: 'checkpoint', mediaId: 'one-image', capturedAt: '2026-09-08T12:00:01.000Z', recordedOn: '2026-09-08' },
    ]

    expect(buildMonthlyProgressFeed(data, '2026-09')).toEqual([
      expect.objectContaining({ sourceId: 'milestone', kind: 'milestone', title: 'Visible checkpoint', goalIds: ['first', 'second'] }),
    ])
  })

  it('shows a completed planned milestone and folds its optional photo into the same activity', () => {
    const goal = numericGoal('goal', 'Launch', 'history')
    goal.milestones = [{ id: 'launch', title: 'Business launched', done: true, completedAt: '2026-09-09T12:00:00.000Z' }]
    goal.history.push({ at: '2026-09-09T12:00:00.000Z', action: 'milestone', note: 'Completed milestone: Business launched' })
    const data = fixture([goal], [{ id: 'history', label: 'Metric', createdAt: at }])
    data.evidence = [{
      id: 'launch-photo', goalId: goal.id, goalIds: [goal.id], kind: 'photo', milestoneId: 'launch', mediaId: 'launch-image',
      capturedAt: '2026-09-09T12:01:00.000Z', recordedOn: '2026-09-09', note: 'Launch screen',
    }]

    expect(buildMonthlyProgressFeed(data, '2026-09')).toEqual([
      expect.objectContaining({
        key: 'milestone:goal:launch',
        source: 'milestone',
        kind: 'milestone',
        title: 'Business launched',
        note: 'Launch screen',
        mediaId: 'launch-image',
        goalIds: ['goal'],
      }),
    ])

    data.evidence = []
    expect(buildMonthlyProgressFeed(data, '2026-09')).toEqual([
      expect.objectContaining({ key: 'milestone:goal:launch', title: 'Business launched', mediaId: undefined }),
    ])
  })

  it('uses inclusive local-date month boundaries rather than UTC timestamp spillover', () => {
    const goal = numericGoal('weight', 'Weight', 'weight')
    const data = fixture([goal], [{ id: 'weight', label: 'Weight', unit: 'lbs', createdAt: at }])
    data.progress = [
      { ...observation('aug-local', goal.id, 'weight', '2026-08-31', 139), recordedAt: '2026-09-01T02:00:00.000Z' },
      observation('sep-first', goal.id, 'weight', '2026-09-01', 140),
      observation('sep-last', goal.id, 'weight', '2026-09-30', 141),
      observation('oct-first', goal.id, 'weight', '2026-10-01', 142),
    ]

    expect(monthBounds('2024-02')).toEqual({ key: '2024-02', start: '2024-02-01', end: '2024-02-29', label: 'February 2024' })
    expect(() => monthBounds('2026-13')).toThrow(RangeError)
    expect(isLocalDateInMonth('2026-09-01', '2026-09')).toBe(true)
    expect(isLocalDateInMonth('2026-09-30', '2026-09')).toBe(true)
    expect(isLocalDateInMonth('2026-09-31', '2026-09')).toBe(false)
    expect(comparisonPeriodLabel('2026-09-01', '2026-09-30')).toBe('Sep 1–30, 2026')
    expect(buildMonthlyProgressFeed(data, '2026-09').map(item => item.sourceId).sort()).toEqual(['sep-first', 'sep-last'])
  })

  it('does not call one observation a trend or compare it with another month', () => {
    const goal = numericGoal('income', 'Online income', 'income', { unit: 'USD/month' })
    const data = fixture([goal], [{ id: 'income', label: 'Online income', unit: 'USD/month', createdAt: at }])
    data.progress = [
      observation('august', goal.id, 'income', '2026-08-31', 500),
      observation('september', goal.id, 'income', '2026-09-15', 700),
    ]

    const [summary] = buildMonthlyMeasurementSummaries(data, '2026-09')
    expect(summary).toMatchObject({ observationCount: 1, hasComparison: false })
    expect(summary.first.value).toBe(700)
    expect(summary.latest.value).toBe(700)
    expect(summary.change).toBeUndefined()
    expect(summary.comparisonLabel).toBeUndefined()
  })

  it('returns an explicit empty state and adds compact unconfigured rows only when requested', () => {
    const first = numericGoal('first', '140 lbs clean', 'weight')
    const second = numericGoal('second', '170 lbs clean', 'weight', { horizon: '6M', deadline: '2027-03-01' })
    const data = fixture([first, second], [{ id: 'weight', label: 'Weight', unit: 'lbs', createdAt: at }])

    const empty = buildMonthlyProgressView(data, '2026-09')
    expect(empty).toMatchObject({ isEmpty: true, measurementSummaries: [], entries: [], unconfiguredNumericRows: [] })

    const withRows = buildMonthlyProgressView(data, '2026-09', { includeUnconfiguredNumericRows: true })
    expect(withRows.isEmpty).toBe(true)
    expect(withRows.unconfiguredNumericRows).toHaveLength(1)
    expect(withRows.unconfiguredNumericRows[0]).toMatchObject({
      historyId: 'weight',
      reason: 'needs-first-observation',
      goalIds: ['first', 'second'],
    })
    expect(buildUnconfiguredNumericRows(data)[0].targets.map(item => item.title)).toEqual(['140 lbs clean', '170 lbs clean'])
  })
})
