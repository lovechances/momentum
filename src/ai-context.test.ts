import { describe, expect, it } from 'vitest'
import type { AppData, Goal, ProgressEntry, Task } from './domain'
import { buildPlanAiContext, buildTodayAiContext, aiContextCharacterCount } from './ai-context'
import { createInitialData } from './seed'

const date = '2026-09-15'
const timestamp = `${date}T14:00:00.000Z`

function fixture() {
  const data = createInitialData(new Date(timestamp))
  data.onboarded = true
  data.tasks = [
    { id: 'ordinary', title: 'Buy groceries', kind: 'task', section: 'Day', dueDate: date, done: false, status: 'active', createdAt: timestamp, carriedCount: 0 },
    { id: 'completed-move', title: 'Test one alert', kind: 'move', section: 'Moves That Matter', goalId: 'seed-goal-2', dueDate: date, done: true, status: 'active', resolvedAt: timestamp, createdAt: timestamp, carriedCount: 0 },
    { id: 'dropped-move', title: 'Old blocked attempt', kind: 'move', section: 'Moves That Matter', goalId: 'seed-goal-2', dueDate: '2026-09-13', done: false, status: 'dropped', resolvedAt: timestamp, createdAt: timestamp, carriedCount: 0 },
  ]
  const goal = data.goals.find(item => item.id === 'seed-goal-2')!
  goal.nextAction = 'Trace the next listing through Discord'
  goal.milestones = [
    { id: 'known-next', title: 'Verify an end-to-end alert', done: false },
    { id: 'already-done', title: 'Create the repository', done: true, completedAt: timestamp },
  ]
  const weight = data.goals.find(item => item.id === 'seed-goal-1')!
  data.progress = [{ id: 'weight-observation', goalId: weight.id, historyId: weight.measurementHistoryId, value: 141, note: 'Morning weigh-in', recordedAt: timestamp, recordedOn: date }]
  data.evidence = [{ id: 'private-photo', goalId: weight.id, goalIds: [weight.id], historyId: weight.measurementHistoryId, kind: 'photo', capturedAt: timestamp, recordedOn: date, note: 'Front view', mediaId: 'secret-local-media-id' }]
  return data
}

describe('AI context builder', () => {
  it('supplies hydrated Today goals, task states, milestones, and recent progress without media', () => {
    const data = fixture()
    const paused = data.goals.find(goal => goal.id === 'seed-goal-3')!
    paused.status = 'paused'
    const context = buildTodayAiContext(data, date, 'America/New_York')

    expect(context.contextState).toBe('supplied')
    expect(context.tasksState).toBe('supplied')
    expect(context.localDate).toBe(date)
    expect(context.timeZone).toBe('America/New_York')
    expect(context.goals.some(goal => goal.id === paused.id)).toBe(false)
    expect(context.goals.find(goal => goal.id === 'seed-goal-2')?.unfinishedMilestones).toEqual([
      { id: 'known-next', title: 'Verify an end-to-end alert' },
    ])
    expect(context.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'ordinary', done: false }),
      expect.objectContaining({ id: 'completed-move', done: true }),
      expect.objectContaining({ id: 'dropped-move', status: 'dropped' }),
    ]))
    expect(context.recentProgress).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'weight-observation', type: 'measurement', value: 141 }),
      expect.objectContaining({ id: 'private-photo', type: 'photo', note: 'Front view' }),
    ]))
    expect(JSON.stringify(context)).not.toContain('secret-local-media-id')
    expect(JSON.stringify(context)).not.toContain('mediaId')
  })

  it('distinguishes an explicitly supplied empty task history', () => {
    const data = fixture()
    data.tasks = []
    const context = buildTodayAiContext(data, date, 'UTC')
    expect(context.tasksState).toBe('supplied')
    expect(context.tasks).toEqual([])
  })

  it('excludes deleted and excluded Today tasks while supplying bounded execution outcomes', () => {
    const data = fixture()
    data.tasks = [
      {
        id: 'active-detail', title: 'Call one customer', details: 'd'.repeat(500), kind: 'move', section: 'Moves That Matter', goalId: 'seed-goal-2', dueDate: date,
        done: false, status: 'active', createdAt: timestamp, carriedCount: 0,
        history: Array.from({ length: 5 }, (_, index) => ({ at: `${date}T1${index}:00:00.000Z`, action: 'edited' as const, details: `prior-${index}-${'x'.repeat(300)}` })),
      },
      { id: 'deleted-today', title: 'Deleted move', kind: 'move', section: 'Moves That Matter', goalId: 'seed-goal-2', dueDate: date, done: false, status: 'deleted', resolvedAt: timestamp, createdAt: timestamp, carriedCount: 0 },
      { id: 'excluded-today', title: 'Excluded routine', kind: 'routine', section: 'Morning', goalId: 'seed-goal-2', dueDate: date, done: false, status: 'excluded', resolvedAt: timestamp, createdAt: timestamp, carriedCount: 0 },
      { id: 'deleted-completed', title: 'Completed then removed', kind: 'move', section: 'Moves That Matter', goalId: 'seed-goal-2', dueDate: date, done: true, status: 'deleted', resolvedAt: timestamp, createdAt: timestamp, carriedCount: 0 },
      { id: 'overdue-active', title: 'Still needs a rollover decision', kind: 'move', section: 'Moves That Matter', goalId: 'seed-goal-2', dueDate: '2026-08-01', done: false, status: 'active', createdAt: timestamp, carriedCount: 0 },
      { id: 'rolled-history', title: 'Rolled move', kind: 'move', section: 'Moves That Matter', goalId: 'seed-goal-2', dueDate: '2026-09-14', done: false, status: 'rolled', resolvedAt: timestamp, createdAt: timestamp, carriedCount: 1 },
    ]

    const context = buildTodayAiContext(data, date, 'UTC')
    expect(context.tasks.map(task => task.id)).toEqual(['active-detail', 'deleted-completed', 'rolled-history', 'overdue-active'])
    expect(context.tasks[0]).toMatchObject({
      details: 'd'.repeat(360),
      outcome: 'open',
      recentHistory: [
        expect.objectContaining({ details: `prior-2-${'x'.repeat(232)}` }),
        expect.objectContaining({ details: `prior-3-${'x'.repeat(232)}` }),
        expect.objectContaining({ details: `prior-4-${'x'.repeat(232)}` }),
      ],
    })
    expect(context.tasks.find(task => task.id === 'deleted-completed')).toMatchObject({ outcome: 'completed', status: 'deleted' })
    expect(context.tasks.find(task => task.id === 'rolled-history')).toMatchObject({ outcome: 'rolled', resolvedAt: timestamp })
    expect(context.tasks.find(task => task.id === 'overdue-active')).toMatchObject({ outcome: 'open' })
  })

  it('keeps the serialized request safely below the server limit', () => {
    const data = fixture()
    const goalTemplate = data.goals[0]
    data.goals = Array.from({ length: 30 }, (_, index): Goal => ({
      ...goalTemplate,
      id: `goal-${index}`,
      title: `Goal ${index} ${'x'.repeat(400)}`,
      nextAction: 'n'.repeat(600),
      contextNotes: Array.from({ length: 8 }, () => 'c'.repeat(500)),
      milestones: Array.from({ length: 12 }, (__, milestone) => ({ id: `m-${index}-${milestone}`, title: 'm'.repeat(400), done: false })),
      createdAt: `${date}T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
    }))
    data.tasks = Array.from({ length: 60 }, (_, index): Task => ({
      id: `task-${index}`, title: 't'.repeat(400), details: 'd'.repeat(800), kind: 'move', section: 'Moves That Matter', goalId: `goal-${index % 24}`, dueDate: date, done: false, createdAt: timestamp, carriedCount: 0,
      history: Array.from({ length: 6 }, (__, history) => ({ at: timestamp, action: 'edited' as const, title: `old-${history}-${'x'.repeat(300)}`, details: 'h'.repeat(500) })),
    }))
    data.progress = Array.from({ length: 50 }, (_, index): ProgressEntry => ({
      id: `entry-${index}`, goalId: `goal-${index % 24}`, historyId: `history-${index % 4}`, value: index, note: 'p'.repeat(400), recordedAt: timestamp, recordedOn: date,
    }))
    const context = buildTodayAiContext(data, date, 'America/New_York')
    expect(aiContextCharacterCount(context)).toBeLessThanOrEqual(11_500)
    expect(context.goals.length).toBeGreaterThanOrEqual(4)
    const suppliedGoalIds = new Set(context.goals.map(goal => goal.id))
    expect(context.tasks.length).toBeGreaterThan(0)
    expect(context.tasks.every(task => !task.goalId || suppliedGoalIds.has(task.goalId))).toBe(true)
    expect(context.recentProgress.every(item => item.goalIds.every(goalId => suppliedGoalIds.has(goalId)))).toBe(true)
  })

  it('removes inactive linked-goal IDs from otherwise relevant progress', () => {
    const data = fixture()
    const active = data.goals.find(goal => goal.id === 'seed-goal-1')!
    const inactive = data.goals.find(goal => goal.id === 'seed-goal-4')!
    inactive.status = 'paused'
    inactive.measurementHistoryId = active.measurementHistoryId

    const context = buildTodayAiContext(data, date, 'UTC')
    const measurement = context.recentProgress.find(item => item.id === 'weight-observation')

    expect(context.goals.some(goal => goal.id === inactive.id)).toBe(false)
    expect(measurement?.goalIds).toContain(active.id)
    expect(measurement?.goalIds).not.toContain(inactive.id)
  })

  it('builds a selected-goal plan context with exact IDs and related execution', () => {
    const data = fixture()
    const goal = data.goals.find(item => item.id === 'seed-goal-2')!
    goal.links = ['seed-goal-3']
    const context = buildPlanAiContext(data, goal, date)
    expect(context.contextState).toBe('supplied')
    expect(context.goal.id).toBe(goal.id)
    expect(context.relatedGoals[0]?.id).toBe('seed-goal-3')
    expect(context.tasks.find(task => task.id === 'completed-move')?.done).toBe(true)
    expect(context.tasks.some(task => task.id === 'ordinary')).toBe(false)
  })

  it('does not multiply one shared observation into copied AI progress events', () => {
    const data = fixture()
    const weightGoals = data.goals.filter(goal => goal.unit === 'lbs')
    const historyId = 'shared-weight'
    for (const goal of weightGoals) goal.measurementHistoryId = historyId
    data.progress = [{ id: 'single-weight', goalId: weightGoals[0].id, historyId, value: 142, recordedAt: timestamp, recordedOn: date }]
    data.evidence.push({ id: 'single-weight-links', goalId: weightGoals[0].id, goalIds: [weightGoals[0].id], historyId, observationId: 'single-weight', value: 142, kind: 'number', capturedAt: timestamp, recordedOn: date })
    const context = buildTodayAiContext(data, date, 'UTC')
    expect(context.recentProgress.filter(entry => entry.id === 'single-weight')).toHaveLength(1)
    expect(context.recentProgress.some(entry => entry.id === 'single-weight-links')).toBe(false)
    expect(context.recentProgress.find(entry => entry.id === 'single-weight')?.goalIds).toEqual(weightGoals.map(goal => goal.id))
  })

  it('represents shared standalone image evidence once with unioned goals and no local media identifier', () => {
    const data = fixture()
    const goals = data.goals.filter(goal => goal.status === 'active').slice(0, 2)
    data.evidence = [
      { id: 'shared-photo-first', goalId: goals[0].id, kind: 'photo', note: 'Same private photo', mediaId: 'never-send-this-media-id', capturedAt: timestamp, recordedOn: date },
      { id: 'shared-photo-second', goalId: goals[1].id, kind: 'photo', mediaId: 'never-send-this-media-id', capturedAt: `${date}T14:00:01.000Z`, recordedOn: date },
    ]

    const context = buildTodayAiContext(data, date, 'UTC')
    const shared = context.recentProgress.filter(entry => entry.id === 'shared-photo-first' || entry.id === 'shared-photo-second')
    expect(shared).toHaveLength(1)
    expect(shared[0]).toMatchObject({
      id: 'shared-photo-first',
      type: 'photo',
      goalIds: goals.map(goal => goal.id),
      note: 'Same private photo',
    })
    expect(JSON.stringify(context)).not.toContain('never-send-this-media-id')
    expect(JSON.stringify(context)).not.toContain('mediaId')
  })

  it('carries linked-history goal relationships into Plan evidence without local media fields', () => {
    const data = fixture()
    const goals = data.goals.filter(goal => goal.status === 'active').slice(0, 2)
    const historyId = 'shared-plan-history'
    for (const goal of goals) goal.measurementHistoryId = historyId
    data.evidence = [{
      id: 'shared-history-photo', goalId: goals[0].id, historyId, kind: 'photo', mediaId: 'private-plan-media', capturedAt: timestamp, recordedOn: date,
    }]

    const context = buildPlanAiContext(data, goals[0], date)
    expect(context.recentProgress).toContainEqual(expect.objectContaining({
      id: 'shared-history-photo',
      goalIds: goals.map(goal => goal.id),
    }))
    expect(JSON.stringify(context)).not.toContain('private-plan-media')
    expect(JSON.stringify(context)).not.toContain('mediaId')
    expect(JSON.stringify(context)).not.toContain('blob')
  })

  it('canonicalizes one physical capture before ordering and retains milestone semantics', () => {
    const data = fixture()
    const goals = data.goals.filter(goal => goal.status === 'active').slice(0, 2)
    const historyId = 'canonical-shared-history'
    for (const goal of goals) goal.measurementHistoryId = historyId
    data.evidence = [
      { id: 'later-photo', goalId: goals[0].id, historyId, kind: 'photo', mediaId: 'same-private-media', capturedAt: '2026-09-15T18:00:00.000Z', recordedOn: '2026-09-15' },
      { id: 'earlier-milestone', goalId: goals[1].id, historyId, kind: 'milestone', mediaId: 'same-private-media', note: 'Milestone proof', capturedAt: '2026-09-14T18:00:00.000Z', recordedOn: '2026-09-14' },
    ]

    const context = buildTodayAiContext(data, date, 'UTC')
    const capture = context.recentProgress.filter(entry => entry.id === 'earlier-milestone' || entry.id === 'later-photo')
    expect(capture).toEqual([expect.objectContaining({
      id: 'earlier-milestone',
      type: 'milestone',
      date: '2026-09-14',
      goalIds: goals.map(goal => goal.id),
      note: 'Milestone proof',
    })])
    expect(JSON.stringify(context)).not.toContain('same-private-media')
  })

  it('serializes a milestone and its later photo attachment as one AI progress event', () => {
    const data = fixture()
    const goal = data.goals.find(item => item.status === 'active')!
    data.evidence = [
      { id: 'milestone-row', goalId: goal.id, milestoneId: 'launch', kind: 'milestone', note: 'Launch finished', capturedAt: '2026-09-14T12:00:00.000Z', recordedOn: '2026-09-14' },
      { id: 'bridge-row', goalId: goal.id, milestoneId: 'launch', mediaId: 'private-photo', kind: 'photo', capturedAt: '2026-09-15T12:00:00.000Z', recordedOn: '2026-09-15' },
      { id: 'relationship-row', goalId: goal.id, mediaId: 'private-photo', kind: 'photo', capturedAt: '2026-09-15T12:00:01.000Z', recordedOn: '2026-09-15' },
    ]

    const context = buildTodayAiContext(data, date, 'UTC')
    const captures = context.recentProgress.filter(entry => ['milestone-row', 'bridge-row', 'relationship-row'].includes(entry.id))
    expect(captures).toEqual([expect.objectContaining({ id: 'milestone-row', type: 'milestone', note: 'Launch finished' })])
    expect(JSON.stringify(context)).not.toContain('private-photo')
  })
})
