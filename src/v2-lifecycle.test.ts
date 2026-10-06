import { describe, expect, it } from 'vitest'
import type { AppData, Task } from './domain'
import { createInitialData } from './seed'
import { completeReviewedGoal, completeTaskForPastDay, confirmMissedDay, goalPresentation, horizonPlanningCandidates, newPeriodPlanningDue } from './lifecycle'
import { reviewDeadline } from './goals'
import { calculateMomentum } from './momentum'
import { dueEvidence, periodFor, reconcileSchedule } from './scheduler'
import { recapFacts, recapStorySelection } from './recap'
import { migrateSnapshot } from './migrations'
import { createBackup, validateBackup } from './backup'

const logged = '2026-10-06T12:15:00.000Z'
const initial = () => createInitialData(new Date('2026-09-15T12:00:00.000Z'))
const move = (id: string, day: string, done = false): Task => ({ id, title: id, section: 'Moves That Matter', kind: 'move', dueDate: day, done, createdAt: `${day}T12:00:00.000Z`, carriedCount: 0, status: 'active' })
const routine = (id: string, day: string, done = false): Task => ({ ...move(id, day, done), kind: 'routine', section: 'Morning' })

describe('post-rollover lifecycle', () => {
  it('completes an unresolved goal with a logged timestamp and prior-period effective day', () => {
    const data = initial()
    const next = completeReviewedGoal(data, 'seed-goal-1', logged)
    const goal = next.goals.find(item => item.id === 'seed-goal-1')!
    expect(goal.status).toBe('completed')
    expect(goal.history.at(-1)).toMatchObject({ action: 'completed', at: logged, effectiveOn: '2026-09-30' })
    expect(recapFacts(next, periodFor('month', '2026-09-20', data.planning.anchorMonth, data.planning.trackingStartedOn)).completedGoals).toContain(goal.title)
    expect(completeReviewedGoal(next, goal.id, logged)).toEqual(next)
  })

  it('continues, adjusts and closes without changing goal identity or conflating outcomes', () => {
    const source = initial().goals[0]
    const continued = reviewDeadline(source, 'continue', 'unrealistic', { deadline: '2026-11-01', at: logged })
    expect(continued).toMatchObject({ id: source.id, status: 'active', deadline: '2026-11-01' })
    expect(continued.history.at(-1)?.action).toBe('continued')
    const adjusted = reviewDeadline(source, 'adjust', 'priorities-changed', { deadline: '2026-11-01', target: 135, nextAction: 'Train', at: logged })
    expect(adjusted).toMatchObject({ id: source.id, title: '135 lbs clean', target: 135, nextAction: 'Train' })
    expect(adjusted.history.at(-1)?.action).toBe('adjusted')
    const closed = reviewDeadline(source, 'close', 'no-longer-important', { at: logged })
    expect(closed.status).toBe('closed')
    expect(closed.history.at(-1)?.action).toBe('closed')
  })

  it('opens month planning after overdue review and keeps carried goals', () => {
    const data = initial()
    expect(newPeriodPlanningDue(data, '2026-10-06')).toBe(false)
    const reviewed = { ...data, goals: data.goals.map(goal => goal.deadline === '2026-10-01' && goal.status === 'active'
      ? reviewDeadline(goal, 'continue', 'unrealistic', { deadline: '2026-11-01', at: logged }) : goal) }
    expect(newPeriodPlanningDue(reviewed, '2026-10-06')).toBe(true)
    expect(reviewed.goals.find(goal => goal.id === 'seed-goal-1')?.id).toBe('seed-goal-1')
    expect(newPeriodPlanningDue({ ...reviewed, planning: { ...reviewed.planning, openedMonth: '2026-10-01' } }, '2026-10-06')).toBe(false)
  })

  it('places active goals first and recent completions below, with older completions archived', () => {
    const data = initial()
    const source = data.goals[0]
    const recent = { ...source, id: 'recent', status: 'completed' as const, history: [...source.history, { at: logged, action: 'completed' as const, effectiveOn: '2026-10-03' }] }
    const old = { ...source, id: 'old', status: 'completed' as const, history: [...source.history, { at: logged, action: 'completed' as const, effectiveOn: '2026-09-30' }] }
    const list = goalPresentation({ ...data, goals: [recent, old, source] }, '1M', '2026-10-06')
    expect(list.current.map(goal => goal.id)).toEqual([source.id, recent.id])
    expect(list.historical.map(goal => goal.id)).toEqual(['old'])
  })

  it('surfaces approaching adjacent horizons and recognizes linked support without mutation', () => {
    const data = initial()
    const parent = { ...data.goals.find(goal => goal.horizon === '3M')!, id: 'parent', deadline: '2026-11-01', links: [] }
    const child = { ...data.goals[0], id: 'child', links: ['parent'] }
    const snapshot = { ...data, goals: [parent, child] }
    const candidates = horizonPlanningCandidates(snapshot, '1M', '2026-10-06')
    expect(candidates).toHaveLength(1)
    expect(candidates[0].support.map(goal => goal.id)).toEqual(['child'])
    expect(parent.horizon).toBe('3M')
    expect(horizonPlanningCandidates(snapshot, '1M', '2026-09-06')).toHaveLength(0)
  })

  it('logs a past-day completion without backdating the audit timestamp and rejects older edits', () => {
    const data = { ...initial(), tasks: [move('past', '2026-10-05')] }
    const completed = completeTaskForPastDay(data, 'past', '2026-10-05', logged)
    expect(completed.tasks[0]).toMatchObject({ done: true, completedOn: '2026-10-05', resolvedAt: logged })
    expect(completed.tasks[0].history?.at(-1)).toMatchObject({ at: logged, effectiveOn: '2026-10-05', action: 'completed' })
    expect(completeTaskForPastDay(data, 'past', '2026-10-02', logged)).toEqual(data)
    expect(calculateMomentum(completed.tasks, [], [], '2026-10-06').eligibleDays).toBe(1)
    expect(recapFacts(completed, periodFor('month', '2026-10-05')).goalMoves.done).toBe(1)
  })

  it('can log a due routine from yesterday even when its row was never generated', () => {
    const data = initial()
    const id = 'routine:seed-routine-1:2026-10-05'
    const completed = completeTaskForPastDay(data, id, '2026-10-05', logged)
    expect(completed.tasks.find(task => task.id === id)).toMatchObject({ done: true, dueDate: '2026-10-05', completedOn: '2026-10-05', createdAt: logged, resolvedAt: logged })
    expect(completeTaskForPastDay(completed, id, '2026-10-05', logged)).toEqual(completed)
  })

  it('separates unknown routine days from confirmed missed execution', () => {
    const tasks = [move('good', '2026-10-04', true), routine('unknown', '2026-10-05')]
    const unknown = calculateMomentum(tasks, [], [], '2026-10-06')
    const missed = calculateMomentum(tasks, [], [], '2026-10-06', { reviewedDays: [{ date: '2026-10-05', result: 'missed' }] })
    expect(unknown).toMatchObject({ score: 65, status: 'building', eligibleDays: 1, unknownDays: 1, confirmedMissedDays: 0, coverage: 50 })
    expect(missed).toMatchObject({ status: 'building', eligibleDays: 2, unknownDays: 0, confirmedMissedDays: 1, coverage: 100 })
    expect(missed.score).toBeLessThan(unknown.score)
    const reviewed = confirmMissedDay({ ...initial(), tasks }, '2026-10-05', logged)
    expect(confirmMissedDay(reviewed, '2026-10-05', logged)).toEqual(reviewed)
  })

  it('ranks goal work above routine-only work and caps a high-volume day by day', () => {
    const goalDay = calculateMomentum([move('m', '2026-10-05', true), routine('r', '2026-10-05')], [], [], '2026-10-06')
    const routineDay = calculateMomentum([routine('r', '2026-10-05', true)], [], [], '2026-10-06')
    expect(goalDay.score).toBeGreaterThan(routineDay.score)
    const many = Array.from({ length: 30 }, (_, index) => move(`m${index}`, '2026-10-04', true))
    const balanced = calculateMomentum([...many, move('miss', '2026-10-05')], [], [], '2026-10-06', { reviewedDays: [{ date: '2026-10-05', result: 'missed' }] })
    expect(balanced.moves).toBe(50)
  })

  it('keeps unknown scheduled days out of the score and hides an incomplete signal', () => {
    const tasks = [move('done', '2026-10-01', true), ...['2026-10-02', '2026-10-03', '2026-10-04'].map(day => routine(day, day))]
    const unknown = calculateMomentum(tasks, [], [], '2026-10-06')
    const confirmed = calculateMomentum(tasks, [], [], '2026-10-06', { reviewedDays: ['2026-10-02', '2026-10-03', '2026-10-04'].map(date => ({ date, result: 'missed' })) })
    expect(unknown).toMatchObject({ score: 65, status: 'building', eligibleDays: 1, unknownDays: 3, coverage: 25 })
    expect(confirmed).toMatchObject({ status: 'ready', eligibleDays: 4, unknownDays: 0, confirmedMissedDays: 3, coverage: 100 })
    expect(unknown.score).toBeGreaterThan(confirmed.score)
  })

  it('does not let one measured progress event outrank routine execution', () => {
    const goal = { ...initial().goals[0], baseline: 140, target: 150, status: 'active' as const }
    const progress = [
      { id: 'before', goalId: goal.id, historyId: goal.measurementHistoryId, value: 140, recordedAt: '2026-09-30T12:00:00.000Z' },
      { id: 'after', goalId: goal.id, historyId: goal.measurementHistoryId, value: 150, recordedAt: '2026-10-05T12:00:00.000Z' },
    ]
    const measured = calculateMomentum([], [goal], progress, '2026-10-06')
    const routineOnly = calculateMomentum([routine('r', '2026-10-05', true)], [], [], '2026-10-06')
    expect(measured.progress).toBe(100)
    expect(measured.score).toBe(10)
    expect(measured.score).toBeLessThan(routineOnly.score)
  })

  it('requires every scheduled day to be known before publishing a score, then credits a past-day completion', () => {
    const tasks = ['2026-10-02', '2026-10-03', '2026-10-04'].map(day => move(day, day, true)).concat(move('past', '2026-10-05'))
    const before = calculateMomentum(tasks, [], [], '2026-10-06')
    expect(before).toMatchObject({ score: 65, status: 'building', eligibleDays: 3, unknownDays: 1, coverage: 75 })
    const reviewedDays = [{ date: '2026-10-05', result: 'missed' as const }]
    expect(calculateMomentum(tasks, [], [], '2026-10-06', { reviewedDays })).toMatchObject({ score: 49, status: 'ready', confirmedMissedDays: 1 })

    const completed = completeTaskForPastDay({ ...initial(), tasks }, 'past', '2026-10-05', logged)
    const after = calculateMomentum(completed.tasks, [], [], '2026-10-06')
    expect(completed.tasks.find(task => task.id === 'past')?.completedOn).toBe('2026-10-05')
    expect(after).toMatchObject({ score: 65, status: 'ready', eligibleDays: 4, unknownDays: 0, coverage: 100 })
    expect(calculateMomentum(completed.tasks, [], [], '2026-10-06', { reviewedDays })).toMatchObject({ score: 65, confirmedMissedDays: 0 })
  })

  it('rewards consistent moderate goal execution across days', () => {
    const tasks = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'].flatMap(day => [move(`done-${day}`, day, true), move(`missed-${day}`, day), routine(`routine-${day}`, day, true)])
    const consistent = calculateMomentum(tasks, [], [], '2026-10-06')
    const oneBurst = calculateMomentum([move('one', '2026-10-04', true), ...['2026-10-01', '2026-10-02', '2026-10-03'].map(day => move(`missed-${day}`, day))], [], [], '2026-10-06', { reviewedDays: ['2026-10-01', '2026-10-02', '2026-10-03'].map(date => ({ date, result: 'missed' })) })
    expect(consistent).toMatchObject({ eligibleDays: 4, moves: 50, routines: 100 })
    expect(consistent.score).toBeGreaterThan(oneBurst.score)
  })

  it('keeps shared quantitative reminders on two histories, not seven goal titles', () => {
    const data = initial()
    const numberDue = dueEvidence(data.goals, data.evidence, '2026-09-15').filter(item => item.schedule.kind === 'number')
    expect(numberDue).toHaveLength(2)
    const reminders = reconcileSchedule(data, '2026-09-15').reminders.filter(item => item.kind === 'evidence')
    expect(reminders.map(item => item.title)).toContain('Log weight')
    expect(reminders.map(item => item.title)).toContain('Update savings')
  })

  it('selects real movement and attaches evidence without promoting unrelated images', () => {
    const data = initial()
    const savings = data.goals.find(goal => goal.id === 'seed-goal-4')!
    const historyId = savings.measurementHistoryId!
    const snapshot: AppData = { ...data,
      progress: [
        { id: 'start', goalId: savings.id, historyId, value: 2900, recordedAt: '2026-09-15T12:00:00.000Z' },
        { id: 'end', goalId: savings.id, historyId, value: 5336, recordedAt: '2026-09-29T12:00:00.000Z' },
      ],
      evidence: [
        { id: 'receipt', kind: 'screenshot', goalId: savings.id, goalIds: [savings.id], historyId, mediaId: 'bank-photo', capturedAt: '2026-09-29T12:00:00.000Z' },
        { id: 'unrelated', kind: 'photo', mediaId: 'random-photo', capturedAt: '2026-09-28T12:00:00.000Z' },
      ],
    }
    const facts = recapFacts(snapshot, periodFor('month', '2026-09-20', data.planning.anchorMonth, data.planning.trackingStartedOn))
    const selection = recapStorySelection(snapshot, facts)
    expect(selection.numeric).toEqual(expect.arrayContaining([expect.objectContaining({ historyId, change: 2436, evidence: expect.objectContaining({ mediaId: 'bank-photo' }) })]))
    expect(JSON.stringify(selection)).not.toContain('random-photo')
  })

  it('round-trips effective dates and planning reviews through migration and backup', async () => {
    const source = completeReviewedGoal(initial(), 'seed-goal-1', logged)
    const withTask = completeTaskForPastDay({ ...source, tasks: [move('past', '2026-10-05')] }, 'past', '2026-10-05', logged)
    const reviewed = confirmMissedDay(withTask, '2026-10-04', logged)
    const backup = await createBackup(reviewed, [], false)
    expect(validateBackup(backup)).toBe(true)
    const restored = migrateSnapshot(backup.data, new Date(logged))
    expect(restored.goals.find(goal => goal.id === 'seed-goal-1')?.history.at(-1)?.effectiveOn).toBe('2026-09-30')
    expect(restored.tasks[0].history?.at(-1)?.effectiveOn).toBe('2026-10-05')
    expect(restored.planning.reviewedDays?.[0]?.date).toBe('2026-10-04')
    expect(migrateSnapshot(restored, new Date(logged))).toEqual(restored)
  })
})
