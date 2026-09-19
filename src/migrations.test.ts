import { describe, expect, it } from 'vitest'
import { validateBackup } from './backup'
import { confirmProgressLinkSuggestion, migrateSnapshot, progressLinkCompletionPreview } from './migrations'
import { createInitialData } from './seed'
import { deadlineCorrectionPreview, recordProgressInData } from './goals'
import { evidenceTrackKey, reconcileSchedule } from './scheduler'

const fixed = new Date(2026, 8, 14, 12)
const unsharedSeededWeight = (data: ReturnType<typeof createInitialData>) => ({
  ...data,
  goals: data.goals.map(goal => goal.unit === 'lbs' ? { ...goal, measurementHistoryId: `measurement:${goal.id}`, evidenceSchedules: goal.evidenceSchedules.map(schedule => ({ ...schedule, historyId: `measurement:${goal.id}` })) } : goal),
  progressLinkSuggestions: data.progressLinkSuggestions.map(item => item.id === 'link-suggestion:body-weight' ? { ...item, status: 'pending' as const } : item),
})

describe('first-run data and resilient migration', () => {
  it('seeds exactly the locked goals without fabricated current or baseline values', () => {
    const data = createInitialData(fixed)
    expect(data.goals.map(goal => [goal.title, goal.horizon])).toEqual([
      ['140 lbs clean', '1M'],
      ['Finish Buyee', '1M'],
      ['Next project / business started', '1M'],
      ['$7k stacked', '1M'],
      ['Progress Tracker app — completed', '1M'],
      ['$10k stacked', '3M'],
      ['150 lbs clean', '3M'],
      ['First profit from business', '3M'],
      ['Contacts', '3M'],
      ['$20k stacked', '6M'],
      ['Start content', '6M'],
      ['170 lbs clean', '6M'],
      ['$5k/mo+ online', '1Y'],
      ['10k+ on platforms', '1Y'],
      ['One solid mentor', '1Y'],
      ['175–185 lbs clean', '1Y'],
      ['Personal brand reputable', '2Y'],
      ['Location freedom', '2Y'],
      ['Sports car in cash', '2Y'],
    ])
    expect(data.goals).toHaveLength(19)
    expect(data.goals.every(goal => goal.baseline === undefined && goal.current === undefined)).toBe(true)
    const completedSeed = data.goals.find(goal => goal.status === 'completed')
    expect(completedSeed?.title).toBe('Progress Tracker app — completed')
    expect(completedSeed?.history.some(event => event.action === 'completed')).toBe(false)
  })

  it('seeds one shared Weight and Savings history with independent horizon targets', () => {
    const initial = createInitialData(fixed)
    const weight = initial.goals.filter(goal => goal.unit === 'lbs')
    const savings = initial.goals.filter(goal => goal.unit === 'USD' && goal.title.includes('stacked'))
    expect(new Set(weight.map(goal => goal.measurementHistoryId))).toEqual(new Set(['measurement:shared:body-weight']))
    expect(new Set(savings.map(goal => goal.measurementHistoryId))).toEqual(new Set(['measurement:shared:savings-balance']))
    expect(initial.measurementHistories.filter(history => history.id.startsWith('measurement:shared:'))).toHaveLength(2)
    expect(weight.map(goal => goal.target)).toEqual([140, 150, 170, undefined])
    expect(savings.map(goal => goal.target)).toEqual([7000, 10000, 20000])
  })

  it('removes the known g1/g2/g4/g6 visual-scaffold values while keeping explicit title targets', () => {
    const initial = createInitialData(fixed)
    const legacy = {
      ...initial,
      goals: initial.goals.map((goal, index) => ({
        ...goal,
        id: `g${index + 1}`,
        kind: index === 1 ? 'numeric' : goal.kind,
        baseline: index === 0 ? 137 : index === 1 ? 80 : index === 3 || index === 5 ? 5800 : undefined,
        current: index === 0 ? 137 : index === 1 ? 80 : index === 3 || index === 5 ? 5800 : undefined,
        history: [],
      })),
    }
    const migrated = migrateSnapshot(legacy, fixed)
    for (const id of ['g1', 'g2', 'g4', 'g6']) {
      expect(migrated.goals.find(goal => goal.id === id)).toMatchObject({ baseline: undefined, current: undefined })
    }
    expect(migrated.goals.find(goal => goal.id === 'g2')?.kind).toBe('binary')
    expect(migrated.goals.find(goal => goal.id === 'g4')?.target).toBe(7000)
    expect(migrated.goals.find(goal => goal.id === 'g6')?.target).toBe(10000)
    expect(migrated.goals.find(goal => goal.id === 'g5')?.history.some(event => event.action === 'completed')).toBe(false)
  })

  it('preserves real canonical progress and rollover history', () => {
    const initial = createInitialData(fixed)
    const goal = { ...initial.goals[0], baseline: 143, current: 147, history: [...initial.goals[0].history, { at: '2026-09-14T16:00:00.000Z', action: 'progressed' as const, current: 147, target: 150 }] }
    const task = { id: 'old', title: 'Call supplier', section: 'Day' as const, done: false, kind: 'task' as const, dueDate: '2026-09-13', createdAt: '2026-09-13T16:00:00.000Z', carriedCount: 1, status: 'rolled' as const, resolvedAt: '2026-09-14T16:00:00.000Z', rolledToId: 'new' }
    const migrated = migrateSnapshot({ ...initial, goals: [goal], tasks: [task] }, fixed)
    expect(migrated.goals[0]).toMatchObject({ baseline: 143, current: 147 })
    expect(migrated.goals[0].history.at(-1)?.action).toBe('progressed')
    expect(migrated.tasks[0]).toMatchObject({ status: 'rolled', resolvedAt: task.resolvedAt, rolledToId: 'new' })
  })

  it('drops corrupt entities, repairs settings, and remains usable instead of bricking startup', () => {
    const migrated = migrateSnapshot({
      schema: 2,
      goals: [null, { nope: true }],
      tasks: [null, { id: 1 }],
      routines: [{ id: 'r', title: 'Gym', recurrence: { type: 'weekdays-custom', weekdays: [] }, active: true, createdAt: 'bad' }],
      evidence: [{ id: 'e', kind: 'photo', capturedAt: 'bad' }],
      wins: [{ id: 'w', title: 'Win', createdAt: 'bad' }],
      progress: [{ id: 'p', goalId: 'missing', value: Number.NaN, recordedAt: 'bad' }],
      periods: [{ id: 'bad' }],
      settings: { areas: [1], ai: { monthlyCap: Number.NaN, estimatedCost: -2 }, reminders: { recap: 'yes' } },
      onboarded: true,
      updatedAt: 'bad',
    }, fixed)
    expect(migrated.goals).toEqual([])
    expect(migrated.tasks).toEqual([])
    expect(migrated.evidence).toEqual([])
    expect(migrated.progress).toEqual([])
    expect(migrated.settings.ai.monthlyCap).toBe(0.5)
    expect(migrated.settings.ai.estimatedCost).toBe(0)
    expect(migrated.settings.reminders.recap).toBe(true)
    expect(migrated.routines[0].recurrence).toEqual({ type: 'weekdays-custom', weekdays: [1] })
  })

  it('repairs impossible dates and dangling nested references into an exportable snapshot', () => {
    const initial = createInitialData(fixed)
    const first = {
      ...initial.goals[0],
      deadline: '2026-02-31',
      links: [initial.goals[0].id, initial.goals[1].id, 'missing-goal', initial.goals[1].id],
      milestones: [
        { id: 'milestone-1', title: 'Real step', done: false },
        { id: 'milestone-1', title: 'Duplicate step', done: false },
      ],
      evidenceSchedules: [
        { id: 'schedule-1', kind: 'photo' as const, cadence: 'monthly' as const, active: true },
        { id: 'schedule-1', kind: 'photo' as const, cadence: 'monthly' as const, active: true },
      ],
    }
    const migrated = migrateSnapshot({
      ...initial,
      goals: [first, initial.goals[1]],
      routines: [{ ...initial.routines[0], recurrence: { type: 'weekdays-custom', weekdays: [1, 1, 3] } }],
      tasks: [{ id: 'task-1', title: 'Task', section: 'Day', done: false, kind: 'task', dueDate: '2026-02-31', createdAt: '2026-09-14T16:00:00.000Z', carriedCount: 0, rolledToId: 'task-1' }],
      evidence: [
        { id: 'valid-ref', goalId: first.id, scheduleId: 'schedule-1', milestoneId: 'milestone-1', kind: 'photo', capturedAt: '2026-09-14T16:00:00.000Z' },
        { id: 'dangling-ref', goalId: first.id, scheduleId: 'missing-schedule', milestoneId: 'missing-milestone', kind: 'photo', capturedAt: '2026-09-14T16:00:00.000Z' },
        { id: 'missing-goal-ref', goalId: 'missing-goal', scheduleId: 'schedule-1', milestoneId: 'milestone-1', kind: 'photo', capturedAt: '2026-09-14T16:00:00.000Z' },
      ],
      periods: [{ id: 'invalid-period', kind: 'month', start: '2026-02-31', end: '2026-02-01', availableAt: '2026-03-01', finalized: false }],
    }, fixed)

    expect(migrated.goals[0].deadline).not.toBe('2026-02-31')
    expect(migrated.goals[0].links).toEqual([initial.goals[1].id])
    expect(migrated.goals[0].milestones).toHaveLength(1)
    expect(migrated.goals[0].evidenceSchedules).toHaveLength(1)
    expect(migrated.routines[0].recurrence.weekdays).toEqual([1, 3])
    expect(migrated.tasks[0].dueDate).not.toBe('2026-02-31')
    expect(migrated.tasks[0].rolledToId).toBeUndefined()
    expect(migrated.evidence[0]).toMatchObject({ scheduleId: 'schedule-1', milestoneId: 'milestone-1' })
    expect(migrated.evidence[1]).toMatchObject({ goalId: first.id, scheduleId: undefined, milestoneId: undefined })
    expect(migrated.evidence[2]).toMatchObject({ goalId: undefined, scheduleId: undefined, milestoneId: undefined })
    expect(migrated.periods).toEqual([])
    expect(validateBackup({ schema: 3, exportedAt: '2026-09-14T16:00:00.000Z', data: migrated })).toBe(true)
  })

  it('does not re-seed goals or routines into an intentionally empty saved snapshot', () => {
    const initial = createInitialData(fixed)
    const migrated = migrateSnapshot({ ...initial, goals: [], routines: [] }, fixed)
    expect(migrated.goals).toEqual([])
    expect(migrated.routines).toEqual([])
  })

  it('migrates a populated schema-2 snapshot idempotently without changing user records', () => {
    const initial = createInitialData(fixed)
    const selected = [initial.goals[0], initial.goals[6], initial.goals[11], initial.goals[3], initial.goals[5], initial.goals[9], initial.goals[12], initial.goals[1], initial.goals[8]]
    const goals = selected.map(goal => {
      const { measurementHistoryId: _history, deadlineAnchor: _anchor, deadlineProvenance: _provenance, contextNotes: _context, ...legacy } = goal
      const evidenceSchedules = goal.id === initial.goals[3].id
        ? [{ id: `${goal.id}-screenshot`, kind: 'screenshot' as const, cadence: 'monthly' as const, active: true }]
        : goal.id === initial.goals[1].id || goal.id === initial.goals[8].id
          ? []
          : goal.evidenceSchedules.map(({ historyId: _scheduleHistory, ...schedule }) => schedule)
      return { ...legacy, deadline: goal.id === initial.goals[0].id ? '2026-10-14' : goal.deadline, evidenceSchedules }
    })
    const legacy = {
      schema: 2,
      goals,
      tasks: [{ id: 'task', title: 'Already done', section: 'Day', done: true, kind: 'task', goalId: goals[0].id, dueDate: '2026-09-14', createdAt: '2026-09-14T13:00:00.000Z', carriedCount: 0, resolvedAt: '2026-09-14T14:00:00.000Z' }],
      routines: [],
      progress: [
        { id: 'weight-one', goalId: goals[0].id, value: 142, recordedAt: '2026-09-14T15:00:00.000Z', note: 'Morning weight' },
        { id: 'weight-two', goalId: goals[1].id, value: 143, recordedAt: '2026-09-15T15:00:00.000Z', note: 'Next day' },
      ],
      evidence: [{ id: 'photo', goalId: goals[0].id, kind: 'photo', capturedAt: '2026-09-14T15:02:00.000Z', note: 'Front photo', mediaId: 'media-photo' }],
      wins: [{ id: 'win', title: 'Useful conversation', goalId: goals[0].id, createdAt: '2026-09-14T16:00:00.000Z', note: 'Follow up Friday' }],
      periods: [
        { id: 'month:2026-09-01', kind: 'month', start: '2026-09-01', end: '2026-09-30', availableAt: '2026-10-01', finalized: false },
        { id: '3M:2026-07-01', kind: '3M', start: '2026-07-01', end: '2026-09-30', availableAt: '2026-10-01', finalized: false },
        { id: '6M:2026-07-01', kind: '6M', start: '2026-07-01', end: '2026-12-31', availableAt: '2027-01-01', finalized: false },
        { id: 'year:2026-01-01', kind: 'year', start: '2026-01-01', end: '2026-12-31', availableAt: '2027-01-01', finalized: false },
        { id: '3M:2026-04-01', kind: '3M', start: '2026-04-01', end: '2026-06-30', availableAt: '2026-07-01', finalized: true },
      ], settings: initial.settings, onboarded: true, updatedAt: '2026-09-15T16:00:00.000Z',
    }
    const migrated = migrateSnapshot(legacy, fixed)
    expect(migrated.schema).toBe(3)
    expect(migrated.progress.map(item => [item.id, item.recordedAt, item.value, item.note])).toEqual([
      ['weight-one', '2026-09-14T15:00:00.000Z', 142, 'Morning weight'],
      ['weight-two', '2026-09-15T15:00:00.000Z', 143, 'Next day'],
    ])
    expect(migrated.evidence[0]).toMatchObject({ id: 'photo', goalIds: [goals[0].id], mediaId: 'media-photo', recordedOn: '2026-09-14' })
    expect(migrated.wins[0]).toMatchObject({ id: 'win', goalIds: [goals[0].id], recordedOn: '2026-09-14' })
    expect(migrated.goals[0]).toMatchObject({ deadline: '2026-10-14', deadlineProvenance: 'legacy-unknown' })
    expect(migrated.planning).toEqual({ anchorMonth: '2026-09-01', trackingStartedOn: '2026-09-14' })
    expect(migrated.periods).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'month:2026-09-01', start: '2026-09-01', end: '2026-09-30', effectiveStart: '2026-09-14', anchorMonth: '2026-09-01', finalized: false }),
      expect.objectContaining({ id: '3M:2026-04-01', start: '2026-04-01', end: '2026-06-30', finalized: true }),
    ]))
    expect(migrated.periods.some(period => ['3M:2026-07-01', '6M:2026-07-01', 'year:2026-01-01'].includes(period.id))).toBe(false)
    expect(migrated.goals.find(goal => goal.id === initial.goals[1].id)?.evidenceSchedules).toEqual([])
    expect(migrated.goals.find(goal => goal.id === initial.goals[8].id)?.evidenceSchedules).toEqual([])
    expect(migrated.goals.find(goal => goal.id === initial.goals[3].id)?.evidenceSchedules).toMatchObject([{ id: `${initial.goals[3].id}-screenshot`, kind: 'screenshot', cadence: 'monthly', active: false }])
    expect(migrateSnapshot(migrated, fixed)).toEqual(migrated)

    const reconciled = reconcileSchedule(migrated, '2026-09-14')
    expect(reconciled.periods).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: '3M:2026-09-01', start: '2026-09-01', end: '2026-11-30', effectiveStart: '2026-09-14', anchorMonth: '2026-09-01' }),
      expect.objectContaining({ id: '6M:2026-09-01', start: '2026-09-01', end: '2027-02-28', effectiveStart: '2026-09-14', anchorMonth: '2026-09-01' }),
      expect.objectContaining({ id: 'year:2026-09-01', start: '2026-09-01', end: '2027-08-31', effectiveStart: '2026-09-14', anchorMonth: '2026-09-01' }),
      expect.objectContaining({ id: '3M:2026-04-01', start: '2026-04-01', end: '2026-06-30', finalized: true }),
    ]))

    const weightSuggestion = migrated.progressLinkSuggestions.find(item => item.id === 'link-suggestion:body-weight')
    const savingsSuggestion = migrated.progressLinkSuggestions.find(item => item.id === 'link-suggestion:savings-balance')
    expect(weightSuggestion?.status).toBe('pending')
    expect(new Set(migrated.goals.slice(0, 3).map(goal => goal.measurementHistoryId)).size).toBe(3)
    expect(savingsSuggestion?.goalIds).not.toContain(initial.goals[12].id)

    const reminderGoal = migrated.goals.find(goal => goal.id === weightSuggestion!.goalIds[0])!
    const reminderSchedule = reminderGoal.evidenceSchedules.find(schedule => schedule.kind === 'number')!
    const oldTrackId = evidenceTrackKey({ goal: reminderGoal, schedule: reminderSchedule })
    const withHandledReminder = {
      ...migrated,
      reminderOccurrences: [{
        id: `evidence:${oldTrackId}:2026-09-14`,
        trackId: oldTrackId,
        scheduleId: reminderSchedule.id,
        dueDate: '2026-09-14',
        status: 'snoozed' as const,
        snoozedUntil: '2026-09-20',
      }],
    }
    const linked = confirmProgressLinkSuggestion(withHandledReminder, weightSuggestion!.id)
    expect(new Set(linked.goals.slice(0, 3).map(goal => goal.measurementHistoryId))).toEqual(new Set(['measurement:shared:body-weight']))
    expect(linked.progress.map(item => item.id)).toEqual(['weight-one', 'weight-two'])
    expect(new Set(linked.progress.map(item => item.historyId))).toEqual(new Set(['measurement:shared:body-weight']))
    const linkedGoal = linked.goals.find(goal => goal.id === reminderGoal.id)!
    const linkedSchedule = linkedGoal.evidenceSchedules.find(schedule => schedule.id === reminderSchedule.id)!
    const newTrackId = evidenceTrackKey({ goal: linkedGoal, schedule: linkedSchedule })
    expect(linked.reminderOccurrences).toEqual([expect.objectContaining({
      id: `evidence:${newTrackId}:2026-09-14`,
      trackId: newTrackId,
      status: 'snoozed',
      snoozedUntil: '2026-09-20',
    })])
    expect(confirmProgressLinkSuggestion(linked, weightSuggestion!.id)).toEqual(linked)
  })

  it('requires explicit confirmation before a shared history can complete a target', () => {
    const initial = unsharedSeededWeight(createInitialData(fixed))
    const selected = initial.goals.filter(goal => goal.unit === 'lbs').slice(0, 2)
    const snapshot = {
      ...initial,
      goals: initial.goals.map(goal => selected.some(item => item.id === goal.id)
        ? { ...goal, baseline: 130, current: 130, direction: 'increase' as const, createdAt: '2026-09-01T12:00:00.000Z' }
        : goal),
      progress: [{
        id: 'weight-on-selected-date',
        goalId: selected[0].id,
        historyId: selected[0].measurementHistoryId,
        value: 145,
        recordedAt: '2026-09-16T15:00:00.000Z',
        recordedOn: '2026-09-10',
      }],
    }
    const suggestion = snapshot.progressLinkSuggestions.find(item => item.id === 'link-suggestion:body-weight')!
    const selectedGoalIds = selected.map(goal => goal.id)

    expect(confirmProgressLinkSuggestion(snapshot, suggestion.id, selectedGoalIds)).toBe(snapshot)

    const linked = confirmProgressLinkSuggestion(snapshot, suggestion.id, selectedGoalIds, true)
    expect(linked.progressLinkSuggestions.find(item => item.id === suggestion.id)?.status).toBe('confirmed')
    expect(linked.goals.find(goal => goal.id === selected[0].id)).toMatchObject({ status: 'completed', current: 145 })
    expect(linked.goals.find(goal => goal.id === selected[1].id)).toMatchObject({ status: 'active', current: 145 })
    expect(linked.goals.find(goal => goal.id === selected[0].id)?.history.at(-1)).toMatchObject({ action: 'completed', current: 145 })
    expect(linked.goals.find(goal => goal.id === selected[0].id)?.history.at(-1)?.at.slice(0, 10)).toBe('2026-09-10')
  })

  it('does not complete a later-created goal from an observation that predates it', () => {
    const initial = unsharedSeededWeight(createInitialData(fixed))
    const selected = initial.goals.filter(goal => goal.unit === 'lbs').slice(0, 2)
    const snapshot = {
      ...initial,
      goals: initial.goals.map(goal => selected.some(item => item.id === goal.id)
        ? { ...goal, baseline: 130, current: 130, target: 140, direction: 'increase' as const, createdAt: '2026-09-14T12:00:00.000Z' }
        : goal),
      progress: [{
        id: 'pre-goal-weight', goalId: selected[0].id, historyId: selected[0].measurementHistoryId,
        value: 145, recordedAt: '2026-09-15T12:00:00.000Z', recordedOn: '2026-09-10',
      }],
    }
    const suggestion = snapshot.progressLinkSuggestions.find(item => item.id === 'link-suggestion:body-weight')!
    const selectedGoalIds = selected.map(goal => goal.id)
    expect(progressLinkCompletionPreview(snapshot, suggestion.id, selectedGoalIds)).toEqual([])
    const linked = confirmProgressLinkSuggestion(snapshot, suggestion.id, selectedGoalIds)
    expect(linked.goals.filter(goal => selectedGoalIds.includes(goal.id)).every(goal => goal.status === 'active')).toBe(true)
  })

  it('repoints a newer goal that already uses a history included in a confirmed merge', () => {
    const initial = unsharedSeededWeight(createInitialData(fixed))
    const selected = initial.goals.filter(goal => goal.unit === 'lbs').slice(0, 2)
    const oldHistoryId = selected[0].measurementHistoryId!
    const newerGoal = {
      ...selected[1],
      id: 'newer-linked-goal',
      title: 'Later weight target',
      target: 180,
      baseline: 143,
      current: 143,
      measurementHistoryId: oldHistoryId,
      evidenceSchedules: [{ id: 'newer-weekly', kind: 'number' as const, cadence: 'weekly' as const, historyId: oldHistoryId, active: true }],
      createdAt: '2026-09-14T12:00:00.000Z',
    }
    const snapshot = {
      ...initial,
      goals: [...initial.goals, newerGoal],
      progress: [{ id: 'existing-weight', goalId: selected[0].id, historyId: oldHistoryId, value: 143, recordedAt: '2026-09-14T12:00:00.000Z', recordedOn: '2026-09-14' }],
    }
    const suggestion = snapshot.progressLinkSuggestions.find(item => item.id === 'link-suggestion:body-weight')!
    expect(suggestion.goalIds).not.toContain(newerGoal.id)

    const linked = confirmProgressLinkSuggestion(snapshot, suggestion.id)
    const canonicalId = 'measurement:shared:body-weight'
    expect(linked.goals.find(goal => goal.id === newerGoal.id)).toMatchObject({
      measurementHistoryId: canonicalId,
      current: 143,
      evidenceSchedules: [expect.objectContaining({ historyId: canonicalId })],
    })
    expect(linked.progressLinkSuggestions.find(item => item.id === suggestion.id)?.goalIds).toContain(newerGoal.id)

    const updated = recordProgressInData(linked, {
      id: 'next-weight', goalId: newerGoal.id, historyId: canonicalId, value: 145,
      recordedAt: '2026-09-15T12:00:00.000Z', recordedOn: '2026-09-15',
    })
    expect(updated.goals.find(goal => goal.id === newerGoal.id)?.current).toBe(145)
  })

  it('preserves approved goal context notes in schema 3', () => {
    const initial = createInitialData(fixed)
    initial.goals[0] = { ...initial.goals[0], contextNotes: ['Main unfinished part: deployment validation.'] }
    expect(migrateSnapshot(initial, fixed).goals[0].contextNotes).toEqual(['Main unfinished part: deployment validation.'])
  })

  it('classifies a non-default legacy deadline as manual instead of offering to overwrite it', () => {
    const initial = createInitialData(fixed)
    const { deadlineAnchor: _anchor, deadlineProvenance: _provenance, ...legacyGoal } = initial.goals[0]
    const migrated = migrateSnapshot({ ...initial, schema: 2, goals: [{ ...legacyGoal, deadline: '2026-10-20' }] }, fixed)
    expect(migrated.goals[0]).toMatchObject({ deadline: '2026-10-20', deadlineProvenance: 'manual' })
    expect(deadlineCorrectionPreview(migrated)).toEqual([])
  })

  it('normalizes only recognizable old seeded histories without duplicating or rewriting observations', () => {
    const initial = createInitialData(fixed)
    const oldIds = ['seed-goal-1', 'seed-goal-7', 'seed-goal-12']
    const goals = initial.goals.map(goal => oldIds.includes(goal.id) ? { ...goal, measurementHistoryId: `measurement:${goal.id}`, evidenceSchedules: goal.evidenceSchedules.map(schedule => ({ ...schedule, historyId: `measurement:${goal.id}` })) } : goal)
    const oldHistories = oldIds.map(id => ({ id: `measurement:${id}`, label: 'Weight', unit: 'lbs' as const, semanticKey: 'body-weight' as const, scopeKey: 'body', createdAt: fixed.toISOString() }))
    const source = { ...initial, measurementSharingVersion: undefined, goals, measurementHistories: [...initial.measurementHistories.filter(history => history.id !== 'measurement:shared:body-weight'), ...oldHistories], progress: [{ id: 'w1', goalId: oldIds[0], historyId: `measurement:${oldIds[0]}`, value: 132, recordedAt: '2026-09-18T12:00:00.000Z', recordedOn: '2026-09-18' }] }
    const migrated = migrateSnapshot(source, fixed)
    expect(new Set(migrated.goals.filter(goal => oldIds.includes(goal.id)).map(goal => goal.measurementHistoryId))).toEqual(new Set(['measurement:shared:body-weight']))
    expect(migrated.progress[0]).toMatchObject({ historyId: 'measurement:shared:body-weight', value: 132 })
    expect(migrated.measurementHistories.filter(history => !history.mergedIntoId && history.semanticKey === 'body-weight')).toHaveLength(1)
    expect(migrated.goals.find(goal => goal.id === oldIds[0])?.current).toBe(132)
    expect(migrateSnapshot(migrated, fixed)).toEqual(migrated)
  })
})
