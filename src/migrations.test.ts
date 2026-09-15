import { describe, expect, it } from 'vitest'
import { validateBackup } from './backup'
import { migrateSnapshot } from './migrations'
import { createInitialData } from './seed'

const fixed = new Date(2026, 8, 14, 12)

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
    expect(validateBackup({ schema: 2, exportedAt: '2026-09-14T16:00:00.000Z', data: migrated })).toBe(true)
  })

  it('does not re-seed goals or routines into an intentionally empty saved snapshot', () => {
    const initial = createInitialData(fixed)
    const migrated = migrateSnapshot({ ...initial, goals: [], routines: [] }, fixed)
    expect(migrated.goals).toEqual([])
    expect(migrated.routines).toEqual([])
  })
})
