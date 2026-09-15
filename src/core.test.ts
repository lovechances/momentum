import { describe, expect, it } from 'vitest'
import type { AppData, Goal, MediaRecord, Routine, Task } from './domain'
import { localDateOf } from './domain'
import {
  addDays,
  addMonths,
  dueEvidence,
  generateRoutineTasks,
  isRecapEligible,
  isRoutineDue,
  nextEvidenceDate,
  orderRoutineTasksForDisplay,
  periodFor,
  reconcileSchedule,
  removeRoutineTaskInstances,
  resolveRollover,
  rolloverCandidates,
  syncRoutineTaskInstances,
} from './scheduler'
import { calculateMomentum } from './momentum'
import { isMeaningfulRecap, recapFacts } from './recap'
import { createBackup, restoreMedia, validateBackup } from './backup'
import {
  applyMonthlyReset,
  canCallAi,
  estimateCost,
  recordAiResponse,
  recordAiUsage,
  validatePlan,
} from './ai'
import {
  completeGoal,
  createGoal,
  deadlineFor,
  editGoalDetails,
  isDeadlineReviewDue,
  pauseGoal,
  reopenGoal,
  resumeGoal,
  reviewDeadline,
  setMilestoneDone,
  updateNumeric,
} from './goals'
import { seededGoals } from './seed'

const iso = (date: string) => `${date}T12:00:00.000Z`
const goal = (patch: Partial<Goal> = {}): Goal => ({
  id: 'g',
  title: 'Weight',
  horizon: '1M',
  kind: 'numeric',
  baseline: 140,
  current: 143,
  target: 150,
  direction: 'increase',
  unit: 'lbs',
  deadline: '2026-10-01',
  status: 'active',
  color: 'lime',
  milestones: [],
  links: [],
  history: [{ at: iso('2026-09-01'), action: 'created', current: 140, target: 150, deadline: '2026-10-01' }],
  evidenceSchedules: [{ id: 'photo', kind: 'photo', cadence: 'monthly', active: true }],
  createdAt: iso('2026-09-01'),
  ...patch,
})
const routine = (patch: Partial<Routine> = {}): Routine => ({
  id: 'r',
  title: 'Gym',
  section: 'Evening',
  recurrence: { type: 'weekdays' },
  active: true,
  createdAt: iso('2026-09-01'),
  ...patch,
})
const task = (id: string, day: string, kind: Task['kind'], done: boolean, patch: Partial<Task> = {}): Task => ({
  id,
  title: id,
  section: kind === 'move' ? 'Moves That Matter' : 'Day',
  kind,
  done,
  dueDate: day,
  createdAt: iso(day),
  carriedCount: 0,
  status: 'active',
  ...patch,
})
const data = (patch: Partial<AppData> = {}): AppData => ({
  schema: 2,
  goals: [goal()],
  tasks: [],
  routines: [routine()],
  evidence: [],
  wins: [],
  progress: [],
  periods: [],
  settings: {
    areas: ['Body', 'Business', 'Money', 'Life'],
    ai: { enabled: false, monthlyCap: 0.5, month: '2026-09', estimatedCost: 0, inputTokens: 0, outputTokens: 0, requests: 0 },
    reminders: { morning: false, evidence: true, recap: true, deadline: true },
  },
  onboarded: true,
  updatedAt: iso('2026-09-01'),
  ...patch,
})

describe('calendar scheduler', () => {
  it('uses Monday weeks and correct month, quarter, half, and year boundaries', () => {
    expect(periodFor('week', '2026-09-13')).toMatchObject({ start: '2026-09-07', end: '2026-09-13' })
    expect(periodFor('week', '2026-09-14')).toMatchObject({ start: '2026-09-14', end: '2026-09-20' })
    expect(periodFor('month', '2024-02-12').end).toBe('2024-02-29')
    expect(periodFor('3M', '2026-09-21')).toMatchObject({ start: '2026-07-01', end: '2026-09-30' })
    expect(periodFor('6M', '2026-09-21')).toMatchObject({ start: '2026-07-01', end: '2026-12-31' })
    expect(periodFor('year', '2026-09-21')).toMatchObject({ start: '2026-01-01', end: '2026-12-31' })
  })

  it('adds calendar days and clamps calendar months', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29')
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonths('2026-11-30', 3)).toBe('2027-02-28')
  })

  it('assigns UTC timestamps to the device-local calendar day', () => {
    expect(localDateOf('2026-09-15T03:30:00.000Z')).toBe('2026-09-14')
  })

  it('supports daily, weekdays, and selected weekdays without backdating a routine', () => {
    expect(isRoutineDue(routine({ recurrence: { type: 'daily' } }), '2026-09-13')).toBe(true)
    expect(isRoutineDue(routine(), '2026-09-13')).toBe(false)
    expect(isRoutineDue(routine(), '2026-09-14')).toBe(true)
    expect(isRoutineDue(routine({ recurrence: { type: 'weekdays-custom', weekdays: [0, 3] } }), '2026-09-13')).toBe(true)
    expect(isRoutineDue(routine({ createdAt: iso('2026-09-15') }), '2026-09-14')).toBe(false)
  })

  it('generates one stable routine instance and does not confuse a normal same-title task', () => {
    const generated = generateRoutineTasks([routine()], [], '2026-09-14')
    expect(generated).toHaveLength(1)
    expect(generated[0].id).toBe('routine:r:2026-09-14')
    expect(generateRoutineTasks([routine()], generated, '2026-09-14')).toHaveLength(0)
    expect(generateRoutineTasks([routine()], [task('manual', '2026-09-14', 'task', false, { title: 'Gym' })], '2026-09-14')).toHaveLength(1)
    expect(generateRoutineTasks([routine()], [task('legacy', '2026-09-14', 'routine', false, { title: 'Gym' })], '2026-09-14')).toHaveLength(0)
  })

  it('applies routine-manager ordering to Today without moving one-off task slots', () => {
    const first = task('first', '2026-09-14', 'routine', false, { sourceRoutineId: 'a' })
    const manual = task('manual', '2026-09-14', 'task', false)
    const second = task('second', '2026-09-14', 'routine', false, { sourceRoutineId: 'b' })
    const ordered = orderRoutineTasksForDisplay(
      [first, manual, second],
      [routine({ id: 'b' }), routine({ id: 'a' })],
    )
    expect(ordered.map(item => item.id)).toEqual(['second', 'manual', 'first'])
  })

  it('syncs only unresolved current/future routine instances and preserves history', () => {
    const current = task('current', '2026-09-14', 'routine', false, { title: 'Old title', sourceRoutineId: 'r' })
    const future = task('future', '2026-09-15', 'routine', false, { title: 'Old title', sourceRoutineId: 'r' })
    const completed = task('done', '2026-09-14', 'routine', true, { title: 'Historical title', sourceRoutineId: 'r', resolvedAt: iso('2026-09-14') })
    const past = task('past', '2026-09-13', 'routine', false, { title: 'Historical title', sourceRoutineId: 'r' })
    const edited = routine({ title: 'New title', section: 'Morning', recurrence: { type: 'daily' } })
    const synced = syncRoutineTaskInstances([current, future, completed, past], edited, '2026-09-14')
    expect(synced.find(item => item.id === 'current')).toMatchObject({ title: 'New title', section: 'Morning' })
    expect(synced.find(item => item.id === 'future')).toMatchObject({ title: 'New title', section: 'Morning' })
    expect(synced.find(item => item.id === 'done')?.title).toBe('Historical title')
    expect(synced.find(item => item.id === 'past')?.title).toBe('Historical title')
  })

  it('removes unresolved generated work when a routine pauses or is deleted', () => {
    const current = task('current', '2026-09-14', 'routine', false, { sourceRoutineId: 'r' })
    const completed = task('done', '2026-09-14', 'routine', true, { sourceRoutineId: 'r', resolvedAt: iso('2026-09-14') })
    const past = task('past', '2026-09-13', 'routine', false, { sourceRoutineId: 'r' })
    expect(syncRoutineTaskInstances([current, completed, past], routine({ active: false }), '2026-09-14').map(item => item.id)).toEqual(['done', 'past'])
    expect(removeRoutineTaskInstances([current, completed, past], 'r', '2026-09-14').map(item => item.id)).toEqual(['done', 'past'])
  })

  it('recovers every overdue one-off and resolves carry/drop exactly once', () => {
    const old = task('old', '2026-09-10', 'task', false)
    expect(rolloverCandidates([old], '2026-09-14')).toEqual([old])
    const carried = resolveRollover(old, 'carry', '2026-09-14', iso('2026-09-14'))
    expect(carried.original.status).toBe('rolled')
    expect(carried.next).toMatchObject({ dueDate: '2026-09-14', carriedCount: 1, status: 'active' })
    expect(rolloverCandidates([carried.original, carried.next!], '2026-09-14')).toHaveLength(0)
    expect(resolveRollover(old, 'drop', '2026-09-14', iso('2026-09-14')).original.status).toBe('dropped')
  })

  it('surfaces new-month planning briefly and clears it once a Goal Move exists', () => {
    const fresh = data({ goals: [], routines: [], tasks: [] })
    expect(reconcileSchedule(fresh, '2026-10-01').reminders.find(item => item.kind === 'planning')).toMatchObject({
      id: 'planning:2026-10-01',
      title: 'October planning is ready',
      action: 'goals',
    })
    const planned = data({ goals: [], routines: [], tasks: [task('move', '2026-10-02', 'move', false)] })
    expect(reconcileSchedule(planned, '2026-10-02').reminders.some(item => item.kind === 'planning')).toBe(false)
    expect(reconcileSchedule(fresh, '2026-10-08').reminders.some(item => item.kind === 'planning')).toBe(false)
  })

  it('uses calendar evidence cadence, schedule identity, and stored last capture', () => {
    expect(nextEvidenceDate('2024-01-31', 'monthly')).toBe('2024-02-29')
    expect(nextEvidenceDate('2026-01-31', 'quarterly')).toBe('2026-04-30')
    const scheduled = goal({
      createdAt: iso('2026-01-01'),
      evidenceSchedules: [{ id: 'front', kind: 'photo', cadence: 'monthly', active: true, firstDueDate: '2026-02-28' }],
    })
    const unrelated = [{ id: 'e', goalId: 'g', scheduleId: 'side', kind: 'photo' as const, capturedAt: iso('2026-02-20') }]
    expect(dueEvidence([scheduled], unrelated, '2026-02-27')).toHaveLength(0)
    expect(dueEvidence([scheduled], unrelated, '2026-02-28')[0].dueDate).toBe('2026-02-28')
    const captured = [{ id: 'e2', goalId: 'g', scheduleId: 'front', kind: 'photo' as const, capturedAt: iso('2026-02-28') }]
    expect(dueEvidence([scheduled], captured, '2026-03-27')).toHaveLength(0)
    expect(dueEvidence([scheduled], captured, '2026-03-28')[0].dueDate).toBe('2026-03-28')
  })

  it('deduplicates related numeric horizon prompts and chooses the earliest deadline deterministically', () => {
    const near = goal({
      id: 'body-1m',
      area: 'Body',
      unit: 'lbs',
      deadline: '2026-10-01',
      evidenceSchedules: [{ id: 'body-1m-number', kind: 'number', cadence: 'weekly', active: true }],
    })
    const far = goal({
      id: 'body-6m',
      area: ' body ',
      unit: 'LBS',
      deadline: '2027-03-01',
      evidenceSchedules: [{ id: 'body-6m-number', kind: 'number', cadence: 'weekly', active: true }],
    })

    expect(dueEvidence([far, near], [], '2026-09-14')).toEqual([
      { goal: near, schedule: near.evidenceSchedules[0], dueDate: '2026-09-01' },
    ])
  })

  it('reduces the seeded Body and Money horizon ladders to four distinct prompts', () => {
    const seeded = seededGoals(new Date(2026, 8, 14, 12))
    const due = dueEvidence(seeded, [], '2026-09-14')
    expect(due).toHaveLength(4)
    expect(new Set(due.map(item => item.goal.id))).toEqual(new Set(['seed-goal-1', 'seed-goal-4']))
    expect(new Set(due.map(item => item.schedule.kind))).toEqual(new Set(['number', 'photo', 'screenshot']))
  })

  it('lets one capture advance every related horizon without hiding unrelated measurements', () => {
    const weight = goal({
      id: 'weight-1m',
      area: 'Body',
      unit: 'lbs',
      evidenceSchedules: [{ id: 'weight-weekly', kind: 'number', cadence: 'weekly', active: true }],
    })
    const laterWeight = goal({
      id: 'weight-6m',
      area: 'Body',
      unit: 'lbs',
      deadline: '2027-03-01',
      evidenceSchedules: [{ id: 'later-weight-weekly', kind: 'number', cadence: 'weekly', active: true }],
    })
    const bodyFat = goal({
      id: 'body-fat',
      area: 'Body',
      unit: '%',
      evidenceSchedules: [{ id: 'body-fat-weekly', kind: 'number', cadence: 'weekly', active: true }],
    })
    const capture = [{
      id: 'weight-capture',
      goalId: weight.id,
      scheduleId: weight.evidenceSchedules[0].id,
      kind: 'number' as const,
      capturedAt: iso('2026-09-14'),
      value: 145,
    }]

    expect(dueEvidence([weight, laterWeight], capture, '2026-09-20')).toHaveLength(0)
    expect(dueEvidence([weight, laterWeight], capture, '2026-09-21')).toMatchObject([
      { goal: { id: weight.id }, dueDate: '2026-09-21' },
    ])
    expect(dueEvidence([{ ...weight, status: 'completed' }, laterWeight], capture, '2026-09-20')).toHaveLength(0)
    expect(dueEvidence([{ ...weight, status: 'completed' }, laterWeight], capture, '2026-09-21')).toMatchObject([
      { goal: { id: laterWeight.id }, dueDate: '2026-09-21' },
    ])
    expect(dueEvidence([weight, laterWeight, bodyFat], capture, '2026-09-20')).toMatchObject([
      { goal: { id: bodyFat.id } },
    ])
  })

  it('preserves deliberately separate same-kind schedules on one goal', () => {
    const poses = goal({
      evidenceSchedules: [
        { id: 'front', kind: 'photo', cadence: 'monthly', active: true },
        { id: 'side', kind: 'photo', cadence: 'monthly', active: true },
      ],
    })
    expect(dueEvidence([poses], [], '2026-09-14')).toHaveLength(2)
  })

  it('does not announce empty recaps and honors reminder preferences', () => {
    const empty = reconcileSchedule(data({ goals: [], routines: [] }), '2026-09-14')
    expect(empty.reminders.filter(item => item.kind === 'recap')).toHaveLength(0)
    const priorMove = task('move', '2026-09-10', 'move', true)
    const meaningful = reconcileSchedule(data({ goals: [], routines: [], tasks: [priorMove] }), '2026-09-14')
    expect(meaningful.reminders.some(item => item.id === 'recap:week:2026-09-07')).toBe(true)
    const muted = reconcileSchedule(data({
      goals: [], routines: [], tasks: [priorMove],
      settings: { ...data().settings, reminders: { morning: false, evidence: false, recap: false, deadline: false } },
    }), '2026-09-14')
    expect(muted.reminders.filter(item => item.kind === 'recap')).toHaveLength(0)
  })

  it('reconstructs a missed activity period without creating duplicate records', () => {
    const oldWin = { id: 'win', title: 'Shipped', createdAt: iso('2026-07-04') }
    const first = reconcileSchedule(data({ goals: [], routines: [], wins: [oldWin] }), '2026-09-14')
    expect(first.periods.some(item => item.id === 'month:2026-07-01')).toBe(true)
    const second = reconcileSchedule(data({ goals: [], routines: [], wins: [oldWin], periods: first.periods }), '2026-09-14')
    expect(new Set(second.periods.map(item => item.id)).size).toBe(second.periods.length)
  })
})

describe('Momentum', () => {
  it('has an explicit, honest cold-start state', () => {
    expect(calculateMomentum([], [], [], '2026-09-14')).toMatchObject({ score: 0, status: 'building', eligibleDays: 0 })
    const first = calculateMomentum([task('r', '2026-09-14', 'routine', true)], [], [], '2026-09-14')
    expect(first).toMatchObject({ score: 100, status: 'building', eligibleDays: 1 })
  })

  it('does not count an untouched current morning as a failed day', () => {
    const result = calculateMomentum([task('r', '2026-09-14', 'routine', false)], [], [], '2026-09-14')
    expect(result.eligibleDays).toBe(0)
    expect(result.routines).toBe(0)
  })

  it('becomes ready after three eligible execution days', () => {
    const tasks = ['2026-09-12', '2026-09-13', '2026-09-14'].map((date, index) => task(`r${index}`, date, 'routine', true))
    expect(calculateMomentum(tasks, [], [], '2026-09-14')).toMatchObject({ status: 'ready', eligibleDays: 3, score: 100 })
  })

  it('uses effective weights when a component is absent', () => {
    const result = calculateMomentum([task('m', '2026-09-13', 'move', true)], [], [], '2026-09-14')
    expect(result.score).toBe(100)
    expect(result.weights).toEqual({ moves: 1, routines: 0, progress: 0 })
  })

  it('excludes light-day commitments', () => {
    const result = calculateMomentum([task('m', '2026-09-13', 'move', false, { lightDay: true })], [], [], '2026-09-14')
    expect(result).toMatchObject({ score: 0, eligibleDays: 0 })
  })

  it('averages days so a pile of trivial tasks cannot overpower another day', () => {
    const many = Array.from({ length: 10 }, (_, index) => task(`m${index}`, '2026-09-13', 'move', true))
    const missed = task('missed', '2026-09-14', 'move', false)
    const result = calculateMomentum([...many, missed], [], [], '2026-09-14', { includeCurrentDay: true })
    expect(result.moves).toBe(50)
  })

  it('uses the real previous window for trend and drops work outside 14 days', () => {
    const tasks = [
      task('old', '2026-08-31', 'move', false),
      task('expired', '2026-08-17', 'move', true),
      task('new', '2026-09-10', 'move', true),
    ]
    const result = calculateMomentum(tasks, [], [], '2026-09-14', { includeCurrentDay: true })
    expect(result.moves).toBe(100)
    expect(result.trend).toBe(100)
  })

  it('scores real in-window progress in either direction and ignores future entries', () => {
    const downward = goal({ baseline: 200, current: 175, target: 150, direction: 'decrease' })
    const progress = [
      { id: 'p0', goalId: 'g', value: 200, recordedAt: iso('2026-08-31') },
      { id: 'p1', goalId: 'g', value: 175, recordedAt: iso('2026-09-10') },
      { id: 'future', goalId: 'g', value: 150, recordedAt: iso('2026-09-15') },
    ]
    const result = calculateMomentum([], [downward], progress, '2026-09-14')
    expect(result.progress).toBe(50)
    expect(result.score).toBe(50)
  })

  it('does not penalize numeric goals with no update in the window', () => {
    const result = calculateMomentum([task('m', '2026-09-13', 'move', true)], [goal()], [], '2026-09-14')
    expect(result.score).toBe(100)
    expect(result.weights.progress).toBe(0)
  })
})

describe('goal lifecycle', () => {
  it('clamps horizon deadlines at short month and leap-year boundaries', () => {
    expect(deadlineFor('1M', new Date(2024, 0, 31, 12))).toBe('2024-02-29')
    expect(deadlineFor('1M', new Date(2026, 0, 31, 12))).toBe('2026-02-28')
    expect(deadlineFor('2Y', new Date(2024, 1, 29, 12))).toBe('2026-02-28')
  })

  it('creates honest zero-baseline numeric goals at a fixed time', () => {
    const created = createGoal({ title: ' $10k stacked ', horizon: '3M', baseline: 0, target: 10_000, createdAt: iso('2026-09-14') })
    expect(created).toMatchObject({ title: '$10k stacked', kind: 'numeric', baseline: 0, current: 0, direction: 'increase', deadline: '2026-12-14' })
    expect(created.history[0].at).toBe(iso('2026-09-14'))
  })

  it('records progress separately from an adjustment and completes upward/downward goals', () => {
    const progressed = updateNumeric(goal(), 145, iso('2026-09-10'))
    expect(progressed.history.at(-1)?.action).toBe('progressed')
    expect(updateNumeric(progressed, 150, iso('2026-09-11')).status).toBe('completed')
    const down = goal({ baseline: 200, current: 200, target: 150, direction: 'decrease' })
    expect(updateNumeric(down, 149, iso('2026-09-11')).status).toBe('completed')
  })

  it('uses the first number as an honest baseline when none exists', () => {
    const unset = goal({ baseline: undefined, current: undefined, target: 150, direction: undefined })
    const updated = updateNumeric(unset, 143, iso('2026-09-14'))
    expect(updated).toMatchObject({ baseline: 143, current: 143, status: 'active', direction: 'increase' })
  })

  it('preserves pause, resume, completion, and milestone history', () => {
    const paused = pauseGoal(goal(), iso('2026-09-05'))
    const resumed = resumeGoal(paused, iso('2026-09-06'))
    const completed = completeGoal(resumed, iso('2026-09-07'))
    expect(completed.history.slice(-3).map(item => item.action)).toEqual(['paused', 'resumed', 'completed'])
    const milestoneGoal = goal({ kind: 'milestone', baseline: undefined, current: undefined, target: undefined, milestones: [{ id: 'm', title: 'Ship', done: false }] })
    expect(setMilestoneDone(milestoneGoal, 'm', true, iso('2026-09-08')).status).toBe('completed')
    const numericWithPath = goal({ milestones: [{ id: 'm', title: 'Finish phase one', done: false }] })
    expect(setMilestoneDone(numericWithPath, 'm', true, iso('2026-09-08')).status).toBe('active')
  })

  it('reopens a completed goal for correction without erasing its completion attempt', () => {
    const completed = completeGoal(goal(), iso('2026-09-07'))
    const reopened = reopenGoal(completed, iso('2026-09-08'))
    expect(reopened.status).toBe('active')
    expect(reopened.history.slice(-2).map(item => item.action)).toEqual(['completed', 'reopened'])
  })

  it('records user-approved title and next-action edits without erasing prior history', () => {
    const original = goal()
    const edited = editGoalDetails(original, { title: 'Reach 150 lbs clean', nextAction: 'Plan meals' }, iso('2026-09-14'))
    expect(edited).toMatchObject({ title: 'Reach 150 lbs clean', nextAction: 'Plan meals' })
    expect(edited.history.slice(0, -1)).toEqual(original.history)
    expect(edited.history.at(-1)).toMatchObject({ action: 'adjusted', at: iso('2026-09-14'), current: 143, target: 150 })
  })

  it('continues, adjusts, and closes without rewriting the original attempt', () => {
    const original = goal()
    const continued = reviewDeadline(original, 'continue', 'blocked', { at: iso('2026-10-01'), deadline: '2026-11-01' })
    const adjusted = reviewDeadline(continued, 'adjust', 'unrealistic', { at: iso('2026-11-01'), deadline: '2026-12-01', target: 148 })
    const closed = reviewDeadline(adjusted, 'close', 'priorities-changed', { at: iso('2026-12-01') })
    expect(closed.history.map(item => item.action)).toEqual(['created', 'continued', 'adjusted', 'closed'])
    expect(closed.history[0]).toEqual(original.history[0])
    expect(closed.status).toBe('closed')
  })

  it('does not request deadline review for a reached downward target', () => {
    const down = goal({ baseline: 200, current: 150, target: 150, direction: 'decrease', deadline: '2026-09-14' })
    expect(isDeadlineReviewDue(down, '2026-09-14')).toBe(false)
    expect(isDeadlineReviewDue({ ...down, current: 160 }, '2026-09-14')).toBe(true)
  })
})

describe('truthful recaps', () => {
  it('rejects empty and untouched-routine-only periods as meaningless', () => {
    const period = periodFor('week', '2026-09-10')
    expect(isMeaningfulRecap(data({ goals: [], routines: [] }), period)).toBe(false)
    const untouched = data({ goals: [], routines: [], tasks: [task('r', '2026-09-10', 'routine', false)] })
    expect(isMeaningfulRecap(untouched, period)).toBe(false)
    expect(isRecapEligible(untouched, period, '2026-09-14')).toBe(false)
  })

  it('uses a real prior observation for numeric start/end and ignores later values', () => {
    const period = periodFor('month', '2026-09-05')
    const facts = recapFacts(data({
      routines: [],
      progress: [
        { id: 'before', goalId: 'g', value: 141, recordedAt: iso('2026-08-31') },
        { id: 'p1', goalId: 'g', value: 142, recordedAt: iso('2026-09-02') },
        { id: 'p2', goalId: 'g', value: 144, recordedAt: iso('2026-09-12') },
        { id: 'later', goalId: 'g', value: 149, recordedAt: iso('2026-10-01') },
      ],
    }), period)
    expect(facts.numeric[0]).toMatchObject({ start: 141, end: 144, change: 3, observations: 2, hasComparison: true })
  })

  it('treats a first-ever number as a starting point, not a fabricated comparison', () => {
    const period = periodFor('month', '2026-09-05')
    const firstValueGoal = goal({
      baseline: 143,
      current: 143,
      history: [{ at: iso('2026-09-01'), action: 'created', deadline: '2026-10-01' }],
    })
    const snapshot = data({
      goals: [firstValueGoal],
      routines: [],
      progress: [{ id: 'first', goalId: 'g', value: 143, recordedAt: iso('2026-09-12') }],
    })
    expect(recapFacts(snapshot, period).numeric[0]).toMatchObject({ start: 143, end: 143, hasComparison: false })
    expect(calculateMomentum([], [firstValueGoal], snapshot.progress, '2026-09-14').weights.progress).toBe(0)
  })

  it('counts only actual completion events and excludes light-day commitments', () => {
    const period = periodFor('month', '2026-09-05')
    const completed = goal({ status: 'active', history: [...goal().history, { at: iso('2026-09-07'), action: 'completed' }] })
    const onlyCreated = goal({ id: 'other', title: 'Other', status: 'completed', history: [{ at: iso('2026-09-02'), action: 'created' }] })
    const corrected = goal({ id: 'corrected', title: 'Corrected', history: [...goal().history, { at: iso('2026-09-07'), action: 'completed' }, { at: iso('2026-09-08'), action: 'reopened' }] })
    const facts = recapFacts(data({
      goals: [completed, onlyCreated, corrected],
      routines: [],
      tasks: [task('light', '2026-09-08', 'move', false, { lightDay: true })],
    }), period)
    expect(facts.completedGoals).toEqual(['Weight'])
    expect(facts.goalMoves).toEqual({ done: 0, due: 0 })
  })

  it('reports tied focus areas without contradicting itself and includes real milestones', () => {
    const period = periodFor('month', '2026-09-05')
    const body = goal({ id: 'body', area: 'Body', history: [...goal().history, { at: iso('2026-09-06'), action: 'milestone', note: 'Completed milestone: Meal plan locked' }] })
    const business = goal({ id: 'business', area: 'Business' })
    const facts = recapFacts(data({
      goals: [body, business],
      routines: [],
      tasks: [
        task('body-move', '2026-09-07', 'move', true, { goalId: 'body' }),
        task('business-move', '2026-09-08', 'move', true, { goalId: 'business' }),
      ],
      evidence: [{ id: 'milestone', goalId: 'business', kind: 'milestone', capturedAt: iso('2026-09-09'), note: 'Production validation finished' }],
    }), period)
    expect(facts.strongest).toBe('Body + Business')
    expect(facts.needsAttention).toBe('—')
    expect(facts.milestones).toEqual(['Production validation finished', 'Meal plan locked'])
  })
})

describe('backup integrity', () => {
  it('round-trips data and media bytes with dimensions', async () => {
    const media: MediaRecord = { id: 'media', blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }), mimeType: 'image/jpeg', width: 10, height: 20, bytes: 3, createdAt: iso('2026-09-14') }
    const snapshot = data({ evidence: [{ id: 'e', goalId: 'g', kind: 'photo', capturedAt: iso('2026-09-14'), mediaId: 'media' }] })
    const backup = await createBackup(snapshot, [media], true)
    expect(validateBackup(backup)).toBe(true)
    const restored = await restoreMedia(backup)
    expect(restored[0]).toMatchObject({ id: 'media', width: 10, height: 20, bytes: 3 })
    expect([...new Uint8Array(await restored[0].blob.arrayBuffer())]).toEqual([1, 2, 3])
  })

  it('accepts a valid data-only archive', async () => {
    const backup = await createBackup(data(), [], false)
    expect(validateBackup(backup)).toBe(true)
    expect(await restoreMedia(backup)).toEqual([])
  })

  it('rejects shallow, duplicate, dangling, non-finite, and malformed-media archives', async () => {
    const valid = await createBackup(data(), [], false)
    expect(validateBackup({ schema: 2, exportedAt: iso('2026-09-14'), data: { goals: [], tasks: [] } })).toBe(false)
    expect(validateBackup({ ...valid, data: { ...valid.data, goals: [goal(), goal()] } })).toBe(false)
    expect(validateBackup({ ...valid, data: { ...valid.data, progress: [{ id: 'p', goalId: 'missing', value: 1, recordedAt: iso('2026-09-14') }] } })).toBe(false)
    expect(validateBackup({ ...valid, data: { ...valid.data, progress: [{ id: 'p', goalId: 'g', value: Number.NaN, recordedAt: iso('2026-09-14') }] } })).toBe(false)
    expect(validateBackup({ ...valid, media: [{ id: 'm', mimeType: 'image/jpeg', bytes: 2, createdAt: iso('2026-09-14'), base64: '***' }] })).toBe(false)
  })

  it('refuses media whose declared byte count does not match', async () => {
    const snapshot = data({ evidence: [{ id: 'e', goalId: 'g', kind: 'photo', capturedAt: iso('2026-09-14'), mediaId: 'm' }] })
    const backup = { schema: 2 as const, exportedAt: iso('2026-09-14'), data: snapshot, media: [{ id: 'm', mimeType: 'image/jpeg', bytes: 2, createdAt: iso('2026-09-14'), base64: 'AQ==' }] }
    expect(validateBackup(backup)).toBe(false)
    await expect(restoreMedia(backup)).rejects.toThrow('validation failed')
  })
})

describe('AI cost and response safety', () => {
  const usage = data().settings.ai
  it('resets counters at a local month boundary', () => {
    const reset = applyMonthlyReset({ ...usage, estimatedCost: 0.4, requests: 9 }, new Date(2026, 9, 1, 12))
    expect(reset).toMatchObject({ month: '2026-10', estimatedCost: 0, requests: 0, inputTokens: 0, outputTokens: 0 })
  })

  it('reserves room before a call and records returned usage', () => {
    const september = new Date(2026, 8, 14, 12)
    expect(canCallAi({ ...usage, estimatedCost: 0.49 }, 0.01, september)).toBe(true)
    expect(canCallAi({ ...usage, estimatedCost: 0.491 }, 0.01, september)).toBe(false)
    const recorded = recordAiUsage(usage, 1_000, 1_000, september)
    expect(recorded.requests).toBe(1)
    expect(recorded.estimatedCost).toBe(estimateCost(1_000, 1_000))
    expect(recordAiResponse(usage, undefined, september)).toMatchObject({ requests: 1, estimatedCost: 0.01 })
    expect(() => estimateCost(-1, 2)).toThrow()
  })

  it('accepts bounded structured suggestions and rejects malformed or excessive output', () => {
    const plan = { clarifiedGoal: 'x', milestones: [], actions: ['Do it'], evidenceSuggestions: [], goalLinks: [], notes: '' }
    expect(validatePlan(plan)).toBe(true)
    expect(validatePlan({ ...plan, actions: [1] })).toBe(false)
    expect(validatePlan({ ...plan, actions: Array.from({ length: 13 }, () => 'x') })).toBe(false)
  })
})
