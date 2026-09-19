import { describe, expect, it } from 'vitest'
import type { AppData, Goal, MediaRecord, Routine, Task } from './domain'
import { localDateOf } from './domain'
import {
  addDays,
  addMonths,
  dueEvidence,
  evidenceTrackKey,
  excludeRoutineOccurrence,
  generateRoutineTasks,
  isRecapEligible,
  isRoutineDue,
  matchingEvidenceSchedule,
  nextEvidenceDueForSchedule,
  nextEvidenceDate,
  orderRoutineTasksForDisplay,
  periodFor,
  reconcileSchedule,
  removeRoutineTaskInstances,
  resolveRollover,
  restoreRoutineOccurrence,
  rolloverCandidates,
  syncRoutineTaskInstances,
  updateTaskInData,
  updateEvidenceScheduleTrackInData,
  updateEvidenceInData,
  skipReminderOccurrence,
  satisfyProgressReminderOccurrences,
  satisfyReminderOccurrences,
  satisfyWinReminderOccurrences,
  skipReminderInData,
  snoozeReminderOccurrence,
  snoozeReminderInData,
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
  validateAiResult,
} from './ai'
import {
  addGoalToData,
  completeGoal,
  confirmDeadlineCorrections,
  createGoal,
  deadlineCorrectionPreview,
  deadlineFor,
  editGoalDetails,
  goalProgressPercent,
  isDeadlineReviewDue,
  pauseGoal,
  planningAnchorFor,
  reopenGoal,
  recordProgressInData,
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
  measurementHistoryId: 'measurement:g',
  deadlineAnchor: '2026-09-01',
  deadlineProvenance: 'calendar-default',
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
  schema: 3,
  goals: [goal()],
  tasks: [],
  routines: [routine()],
  evidence: [],
  wins: [],
  progress: [],
  measurementHistories: [{ id: 'measurement:g', label: 'Weight', unit: 'lbs', semanticKey: 'body-weight', scopeKey: 'body', createdAt: iso('2026-09-01') }],
  progressLinkSuggestions: [],
  routineExclusions: [],
  reminderOccurrences: [],
  planning: { anchorMonth: '2026-09-01', trackingStartedOn: '2026-09-01' },
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
    expect(periodFor('3M', '2026-09-21', '2026-09-01')).toMatchObject({ start: '2026-09-01', end: '2026-11-30' })
    expect(periodFor('6M', '2026-09-21', '2026-09-01')).toMatchObject({ start: '2026-09-01', end: '2027-02-28' })
    expect(periodFor('year', '2026-09-21', '2026-09-01')).toMatchObject({ start: '2026-09-01', end: '2027-08-31' })
    expect(periodFor('month', '2026-09-21', '2026-09-01', '2026-09-14')).toMatchObject({ start: '2026-09-01', end: '2026-09-30', effectiveStart: '2026-09-14' })
  })

  it('does not materialize or surface periods wholly before tracking began', () => {
    const snapshot = data({
      goals: [], routines: [],
      tasks: [task('backdated', '2026-09-10', 'move', true)],
      planning: { anchorMonth: '2026-09-01', trackingStartedOn: '2026-09-14' },
    })
    const reconciled = reconcileSchedule(snapshot, '2026-09-14')
    expect(reconciled.periods.some(period => period.end < '2026-09-14')).toBe(false)
    expect(isRecapEligible(snapshot, periodFor('week', '2026-09-10'), '2026-09-14')).toBe(false)
    expect(isMeaningfulRecap(snapshot, periodFor('week', '2026-09-10'))).toBe(false)
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

  it('persists an occurrence exclusion and restores the exact routine task on undo', () => {
    const generated = generateRoutineTasks([routine({ recurrence: { type: 'daily' } })], [], '2026-09-14')[0]
    const snapshot = data({ tasks: [generated] })
    const excluded = excludeRoutineOccurrence(snapshot, generated.id, iso('2026-09-14'))
    expect(excluded.tasks[0]).toMatchObject({ id: generated.id, status: 'excluded', done: false })
    expect(generateRoutineTasks(excluded.routines, [], '2026-09-14', excluded.routineExclusions)).toHaveLength(0)
    const restored = restoreRoutineOccurrence(excluded, generated.id, iso('2026-09-14'))
    expect(restored.tasks[0]).toMatchObject({ ...generated, status: 'active' })
    expect(restored.routineExclusions).toEqual([])
  })

  it('keeps a moved routine occurrence from regenerating on either date', () => {
    const daily = routine({ recurrence: { type: 'daily' } })
    const generated = generateRoutineTasks([daily], [], '2026-09-14')[0]
    const moved = updateTaskInData(data({ routines: [daily], tasks: [generated] }), { ...generated, dueDate: '2026-09-15' }, iso('2026-09-14'))
    expect(moved.tasks[0]).toMatchObject({ id: generated.id, dueDate: '2026-09-15', sourceRoutineId: daily.id })
    expect(generateRoutineTasks([daily], moved.tasks, '2026-09-14', moved.routineExclusions)).toEqual([])
    expect(generateRoutineTasks([daily], moved.tasks, '2026-09-15', moved.routineExclusions)).toEqual([])
    expect(moved.routineExclusions).toMatchObject([{ routineId: daily.id, date: '2026-09-14' }])
  })

  it('does not regenerate a routine occurrence converted to a moved Goal Move', () => {
    const source = routine({ id: 'r', recurrence: { type: 'daily' } })
    const original = generateRoutineTasks([source], [], '2026-09-14')[0]
    const converted = { ...original, dueDate: '2026-09-15', kind: 'move' as const, sourceRoutineId: undefined }
    const edited = updateTaskInData(data({ goals: [], routines: [source], tasks: [original] }), converted, iso('2026-09-14'))

    expect(edited.routineExclusions).toMatchObject([{ routineId: source.id, date: '2026-09-14' }])
    expect(generateRoutineTasks([source], edited.tasks, '2026-09-14', edited.routineExclusions)).toEqual([])
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

  it('applies routine edits only to future unresolved instances and preserves current/history', () => {
    const current = task('current', '2026-09-14', 'routine', false, { title: 'Old title', sourceRoutineId: 'r' })
    const future = task('future', '2026-09-15', 'routine', false, { title: 'Old title', sourceRoutineId: 'r' })
    const completed = task('done', '2026-09-14', 'routine', true, { title: 'Historical title', sourceRoutineId: 'r', resolvedAt: iso('2026-09-14') })
    const past = task('past', '2026-09-13', 'routine', false, { title: 'Historical title', sourceRoutineId: 'r' })
    const edited = routine({ title: 'New title', section: 'Morning', recurrence: { type: 'daily' } })
    const synced = syncRoutineTaskInstances([current, future, completed, past], edited, '2026-09-14')
    expect(synced.find(item => item.id === 'current')).toMatchObject({ title: 'Old title', section: 'Day' })
    expect(synced.find(item => item.id === 'future')).toMatchObject({ title: 'New title', section: 'Morning' })
    expect(synced.find(item => item.id === 'done')?.title).toBe('Historical title')
    expect(synced.find(item => item.id === 'past')?.title).toBe('Historical title')
  })

  it('does not remove today when a recurrence edit makes only future dates eligible', () => {
    const current = task('current', '2026-09-14', 'routine', false, { title: 'Today stays', sourceRoutineId: 'r' })
    const future = task('future', '2026-09-15', 'routine', false, { title: 'Old future', sourceRoutineId: 'r' })
    const tuesdays = routine({ title: 'Future title', recurrence: { type: 'weekdays-custom', weekdays: [2] } })
    const synced = syncRoutineTaskInstances([current, future], tuesdays, '2026-09-14')
    expect(synced.find(item => item.id === 'current')?.title).toBe('Today stays')
    expect(synced.find(item => item.id === 'future')?.title).toBe('Future title')
  })

  it('keeps today when a routine stops but removes unresolved future instances', () => {
    const current = task('current', '2026-09-14', 'routine', false, { sourceRoutineId: 'r' })
    const future = task('future', '2026-09-15', 'routine', false, { sourceRoutineId: 'r' })
    const completed = task('done', '2026-09-14', 'routine', true, { sourceRoutineId: 'r', resolvedAt: iso('2026-09-14') })
    const past = task('past', '2026-09-13', 'routine', false, { sourceRoutineId: 'r' })
    expect(syncRoutineTaskInstances([current, future, completed, past], routine({ active: false }), '2026-09-14').map(item => item.id)).toEqual(['current', 'done', 'past'])
    expect(removeRoutineTaskInstances([current, future, completed, past], 'r', '2026-09-14').map(item => item.id)).toEqual(['done', 'past'])
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

  it('persists one reminder occurrence across refresh, snooze, and skip without a backlog', () => {
    const scheduled = goal({ evidenceSchedules: [{ id: 'weekly', kind: 'number', cadence: 'weekly', historyId: 'measurement:g', firstDueDate: '2026-09-14', active: true }] })
    const first = reconcileSchedule(data({ goals: [scheduled], routines: [] }), '2026-09-14')
    expect(first.reminderOccurrences).toHaveLength(1)
    const second = reconcileSchedule(data({ goals: [scheduled], routines: [], reminderOccurrences: first.reminderOccurrences }), '2026-09-15')
    expect(second.reminderOccurrences).toHaveLength(1)
    const id = first.reminderOccurrences[0].id
    const snoozed = snoozeReminderOccurrence(first.reminderOccurrences, id, '2026-09-20')
    expect(dueEvidence([scheduled], [], '2026-09-19', snoozed)).toHaveLength(0)
    expect(dueEvidence([scheduled], [], '2026-09-20', snoozed)).toHaveLength(1)
    const skipped = skipReminderOccurrence(snoozed, id, iso('2026-09-20'))
    expect(dueEvidence([scheduled], [], '2026-09-20', skipped)).toHaveLength(0)
    expect(dueEvidence([scheduled], [], '2026-09-21', skipped)).toHaveLength(0)
    expect(dueEvidence([scheduled], [], '2026-09-27', skipped)).toHaveLength(1)
  })

  it('advances from a late skip instead of replaying every missed reminder', () => {
    const scheduled = goal({ evidenceSchedules: [{ id: 'weekly', kind: 'number', cadence: 'weekly', historyId: 'measurement:g', firstDueDate: '2026-09-01', active: true }] })
    const occurrence = reconcileSchedule(data({ goals: [scheduled], routines: [] }), '2026-09-30').reminderOccurrences[0]
    const skipped = skipReminderOccurrence([occurrence], occurrence.id, iso('2026-09-30'))
    expect(dueEvidence([scheduled], [], '2026-10-06', skipped)).toHaveLength(0)
    expect(dueEvidence([scheduled], [], '2026-10-07', skipped)).toMatchObject([{ dueDate: '2026-10-07' }])
  })

  it('synthesizes a just-created occurrence before snoozing or skipping it', () => {
    const scheduled = goal({ evidenceSchedules: [{ id: 'weekly', kind: 'number', cadence: 'weekly', historyId: 'measurement:g', firstDueDate: '2026-09-14', active: true }] })
    const fresh = data({ goals: [scheduled], routines: [], reminderOccurrences: [] })
    const occurrenceId = dueEvidence(fresh.goals, fresh.evidence, '2026-09-14', [], fresh.progress)[0].occurrenceId
    expect(snoozeReminderInData(fresh, occurrenceId, '2026-09-20', '2026-09-14').reminderOccurrences).toMatchObject([{ id: occurrenceId, status: 'snoozed', snoozedUntil: '2026-09-20' }])
    expect(skipReminderInData(fresh, occurrenceId, '2026-09-14', iso('2026-09-14')).reminderOccurrences).toMatchObject([{ id: occurrenceId, status: 'skipped', handledAt: iso('2026-09-14') }])
  })

  it('lets one measurement observation satisfy its compatible number occurrence', () => {
    const scheduled = goal({ evidenceSchedules: [{ id: 'weekly', kind: 'number', cadence: 'weekly', historyId: 'measurement:g', firstDueDate: '2026-09-14', active: true }] })
    const first = reconcileSchedule(data({ goals: [scheduled], routines: [] }), '2026-09-14')
    const snapshot = data({ goals: [scheduled], routines: [], reminderOccurrences: first.reminderOccurrences })
    const observation = { id: 'measurement', goalId: scheduled.id, historyId: 'measurement:g', value: 145, recordedAt: iso('2026-09-14'), recordedOn: '2026-09-14' }
    const satisfied = satisfyProgressReminderOccurrences(snapshot, observation)
    expect(satisfied[0]).toMatchObject({ status: 'satisfied', satisfiedByEntryId: observation.id })
    expect(dueEvidence([scheduled], [], '2026-09-20', satisfied, [observation])).toHaveLength(0)
    expect(dueEvidence([scheduled], [], '2026-09-21', satisfied, [observation])).toHaveLength(1)
  })

  it('lets an attached image and a win satisfy compatible capture occurrences', () => {
    const mediaGoal = goal({ id: 'media', measurementHistoryId: undefined, evidenceSchedules: [{ id: 'monthly-photo', kind: 'photo', cadence: 'monthly', firstDueDate: '2026-09-14', active: true }] })
    const noteGoal = goal({ id: 'business', kind: 'qualitative', measurementHistoryId: undefined, evidenceSchedules: [{ id: 'weekly-note', kind: 'note', cadence: 'weekly', firstDueDate: '2026-09-14', active: true }] })
    const first = reconcileSchedule(data({ goals: [mediaGoal, noteGoal], routines: [], measurementHistories: [] }), '2026-09-14')
    const snapshot = data({ goals: [mediaGoal, noteGoal], routines: [], measurementHistories: [], reminderOccurrences: first.reminderOccurrences })
    const milestoneWithPhoto = { id: 'milestone', goalId: mediaGoal.id, goalIds: [mediaGoal.id], kind: 'milestone' as const, capturedAt: iso('2026-09-14'), recordedOn: '2026-09-14', mediaId: 'photo' }
    const afterPhoto = satisfyReminderOccurrences(snapshot, milestoneWithPhoto)
    expect(afterPhoto.find(item => item.scheduleId === 'monthly-photo')).toMatchObject({ status: 'satisfied', satisfiedByEntryId: 'milestone' })
    expect(dueEvidence([mediaGoal], [milestoneWithPhoto], '2026-10-13', afterPhoto)).toHaveLength(0)
    expect(dueEvidence([mediaGoal], [milestoneWithPhoto], '2026-10-14', afterPhoto)).toHaveLength(1)
    const win = { id: 'win', title: 'Shipped one test', goalId: noteGoal.id, goalIds: [noteGoal.id], createdAt: iso('2026-09-14'), recordedOn: '2026-09-14' }
    expect(satisfyWinReminderOccurrences(snapshot, win).find(item => item.scheduleId === 'weekly-note')).toMatchObject({ status: 'satisfied', satisfiedByEntryId: 'win' })
    const businessScreenshot = { id: 'business-shot', goalId: noteGoal.id, goalIds: [noteGoal.id], kind: 'screenshot' as const, capturedAt: iso('2026-09-14'), recordedOn: '2026-09-14', mediaId: 'screenshot' }
    expect(satisfyReminderOccurrences(snapshot, businessScreenshot).find(item => item.scheduleId === 'weekly-note')).toMatchObject({ status: 'satisfied', satisfiedByEntryId: 'business-shot' })
    expect(dueEvidence([noteGoal], [businessScreenshot], '2026-09-20')).toHaveLength(0)
    expect(dueEvidence([noteGoal], [businessScreenshot], '2026-09-21')).toHaveLength(1)
  })

  it('uses a compatible cross-kind scheduled capture date without creating reminder backlog', () => {
    const scheduled = goal({ evidenceSchedules: [
      { id: 'weekly-number', kind: 'number', cadence: 'weekly', historyId: 'measurement:g', firstDueDate: '2026-01-01', active: true },
      { id: 'monthly-photo', kind: 'photo', cadence: 'monthly', historyId: 'measurement:g', firstDueDate: '2026-01-01', active: true },
    ] })
    const initial = reconcileSchedule(data({ goals: [scheduled], routines: [] }), '2026-03-15')
    const photo = { id: 'photo', goalId: 'g', goalIds: ['g'], historyId: 'measurement:g', scheduleId: 'weekly-number', kind: 'photo' as const, mediaId: 'image', capturedAt: iso('2026-03-15'), recordedOn: '2026-03-15' }
    const satisfied = satisfyReminderOccurrences(data({ goals: [scheduled], routines: [], reminderOccurrences: initial.reminderOccurrences }), photo)
    expect(satisfied.find(item => item.scheduleId === 'monthly-photo')?.status).toBe('satisfied')
    expect(dueEvidence([scheduled], [photo], '2026-04-14', satisfied).some(item => item.schedule.id === 'monthly-photo')).toBe(false)
    expect(dueEvidence([scheduled], [photo], '2026-04-15', satisfied).some(item => item.schedule.id === 'monthly-photo')).toBe(true)
  })

  it('keeps cadence on the editable event date for a backdated satisfied capture', () => {
    const scheduled = goal({ evidenceSchedules: [{ id: 'weekly', kind: 'photo', cadence: 'weekly', firstDueDate: '2026-09-01', active: true }] })
    const occurrence = reconcileSchedule(data({ goals: [scheduled], routines: [] }), '2026-09-30').reminderOccurrences[0]
    const photo = { id: 'backdated', goalId: 'g', kind: 'photo' as const, capturedAt: iso('2026-09-30'), recordedOn: '2026-09-01', mediaId: 'image' }
    const satisfied = satisfyReminderOccurrences(data({ goals: [scheduled], routines: [], reminderOccurrences: [occurrence] }), photo)
    expect(dueEvidence([scheduled], [photo], '2026-09-08', satisfied)).toMatchObject([{ dueDate: '2026-09-08' }])
  })

  it('updates shared reminder cadence and pause state as one track', () => {
    const first = goal({ id: 'first', measurementHistoryId: 'shared', evidenceSchedules: [{ id: 'first-photo', kind: 'photo', cadence: 'monthly', historyId: 'shared', active: true }] })
    const second = goal({ id: 'second', measurementHistoryId: 'shared', evidenceSchedules: [{ id: 'second-photo', kind: 'photo', cadence: 'monthly', historyId: 'shared', active: true }] })
    const snapshot = data({ goals: [first, second], routines: [] })
    const paused = updateEvidenceScheduleTrackInData(snapshot, first.id, 'first-photo', { active: false })
    expect(paused.goals.flatMap(item => item.evidenceSchedules).every(item => !item.active)).toBe(true)
    expect(paused.goals.flatMap(item => item.evidenceSchedules).every(item => item.provenance === 'manual')).toBe(true)
    expect(dueEvidence(paused.goals, [], '2026-09-14')).toHaveLength(0)
    const weekly = updateEvidenceScheduleTrackInData(paused, second.id, 'second-photo', { active: true, cadence: 'weekly' })
    expect(weekly.goals.flatMap(item => item.evidenceSchedules).map(item => [item.active, item.cadence])).toEqual([[true, 'weekly'], [true, 'weekly']])
  })

  it('reuses a paused matching reminder instead of creating another schedule', () => {
    const paused = goal({
      evidenceSchedules: [{ id: 'paused-photo', kind: 'photo', cadence: 'monthly', historyId: 'measurement:g', active: false }],
    })

    expect(matchingEvidenceSchedule(paused, 'photo', 'monthly')).toMatchObject({ id: 'paused-photo', active: false })
    const resumed = updateEvidenceScheduleTrackInData(data({ goals: [paused] }), paused.id, 'paused-photo', { active: true })
    expect(resumed.goals[0].evidenceSchedules).toEqual([
      expect.objectContaining({ id: 'paused-photo', kind: 'photo', cadence: 'monthly', active: true }),
    ])
  })

  it('prefers an already-active matching reminder over a stale paused duplicate', () => {
    const duplicate = goal({
      evidenceSchedules: [
        { id: 'paused-photo', kind: 'photo', cadence: 'monthly', historyId: 'measurement:g', active: false },
        { id: 'active-photo', kind: 'photo', cadence: 'monthly', historyId: 'measurement:g', active: true },
      ],
    })

    expect(matchingEvidenceSchedule(duplicate, 'photo', 'monthly')).toMatchObject({ id: 'active-photo', active: true })
  })

  it('removes a reminder track without deleting its captured evidence or leaving dangling references', async () => {
    const first = goal({ id: 'first', measurementHistoryId: 'shared', evidenceSchedules: [{ id: 'first-photo', kind: 'photo', cadence: 'monthly', historyId: 'shared', active: true }] })
    const second = goal({ id: 'second', measurementHistoryId: 'shared', evidenceSchedules: [{ id: 'second-photo', kind: 'photo', cadence: 'monthly', historyId: 'shared', active: true }] })
    const trackId = evidenceTrackKey({ goal: first, schedule: first.evidenceSchedules[0] })
    const snapshot = data({
      goals: [first, second],
      measurementHistories: [{ id: 'shared', label: 'Weight', unit: 'lbs', createdAt: iso('2026-09-01') }],
      evidence: [{ id: 'receipt', goalId: first.id, goalIds: [first.id, second.id], historyId: 'shared', scheduleId: 'first-photo', kind: 'photo', mediaId: 'image', capturedAt: iso('2026-09-01') }],
      reminderOccurrences: [{ id: `evidence:${trackId}:2026-09-01`, trackId, scheduleId: 'first-photo', dueDate: '2026-09-01', status: 'satisfied', handledAt: iso('2026-09-01'), satisfiedByEntryId: 'receipt' }],
    })

    const removed = updateEvidenceScheduleTrackInData(snapshot, first.id, 'first-photo', { remove: true })

    expect(removed.goals.flatMap(item => item.evidenceSchedules)).toEqual([])
    expect(removed.evidence).toEqual([expect.objectContaining({ id: 'receipt', scheduleId: undefined })])
    expect(removed.reminderOccurrences).toEqual([])
    expect(validateBackup(await createBackup(removed, [], false))).toBe(true)
  })

  it('merges reminder tracks when a cadence edit collides with an existing schedule', () => {
    const scheduled = goal({
      measurementHistoryId: 'measurement:g',
      evidenceSchedules: [
        { id: 'monthly-photo', kind: 'photo', cadence: 'monthly', historyId: 'measurement:g', firstDueDate: '2026-09-01', active: true },
        { id: 'quarterly-photo', kind: 'photo', cadence: 'quarterly', historyId: 'measurement:g', firstDueDate: '2026-09-01', active: true },
      ],
    })
    const monthlyTrack = evidenceTrackKey({ goal: scheduled, schedule: scheduled.evidenceSchedules[0] })
    const quarterlyTrack = evidenceTrackKey({ goal: scheduled, schedule: scheduled.evidenceSchedules[1] })
    const snapshot = data({
      goals: [scheduled],
      evidence: [{ id: 'receipt', goalId: scheduled.id, scheduleId: 'quarterly-photo', kind: 'photo', mediaId: 'image', capturedAt: iso('2026-09-01') }],
      reminderOccurrences: [
        { id: `evidence:${monthlyTrack}:2026-09-01`, trackId: monthlyTrack, scheduleId: 'monthly-photo', dueDate: '2026-09-01', status: 'due' },
        { id: `evidence:${quarterlyTrack}:2026-09-01`, trackId: quarterlyTrack, scheduleId: 'quarterly-photo', dueDate: '2026-09-01', status: 'satisfied', handledAt: iso('2026-09-01'), satisfiedByEntryId: 'receipt' },
      ],
    })

    const merged = updateEvidenceScheduleTrackInData(snapshot, scheduled.id, 'monthly-photo', { cadence: 'quarterly' })

    expect(merged.goals[0].evidenceSchedules).toEqual([
      expect.objectContaining({ id: 'monthly-photo', kind: 'photo', cadence: 'quarterly', active: true }),
    ])
    expect(merged.evidence[0].scheduleId).toBe('monthly-photo')
    expect(merged.reminderOccurrences).toEqual([
      expect.objectContaining({ scheduleId: 'monthly-photo', status: 'satisfied', satisfiedByEntryId: 'receipt' }),
    ])
    expect(dueEvidence(merged.goals, merged.evidence, '2026-11-30', merged.reminderOccurrences)).toEqual([])
  })

  it('reopens an old reminder and satisfies the new one when evidence is relinked', () => {
    const first = goal({ id: 'first', measurementHistoryId: 'first-history', evidenceSchedules: [{ id: 'first-photo', kind: 'photo', cadence: 'weekly', historyId: 'first-history', firstDueDate: '2026-09-14', active: true }] })
    const second = goal({ id: 'second', measurementHistoryId: 'second-history', evidenceSchedules: [{ id: 'second-photo', kind: 'photo', cadence: 'weekly', historyId: 'second-history', firstDueDate: '2026-09-14', active: true }] })
    const original = { id: 'capture', goalId: first.id, goalIds: [first.id], historyId: 'first-history', scheduleId: 'first-photo', kind: 'photo' as const, capturedAt: iso('2026-09-14'), recordedOn: '2026-09-14', mediaId: 'image' }
    const initial = data({ goals: [first, second], routines: [], evidence: [original] })
    const occurrences = satisfyReminderOccurrences(initial, original)
    const relinked = updateEvidenceInData({ ...initial, reminderOccurrences: occurrences }, {
      ...original,
      goalId: second.id,
      goalIds: [second.id],
    })

    expect(relinked.evidence[0]).toMatchObject({ goalId: second.id, goalIds: [second.id], historyId: 'second-history', scheduleId: undefined })
    expect(relinked.reminderOccurrences.find(item => item.scheduleId === 'first-photo')).toMatchObject({ status: 'due', satisfiedByEntryId: undefined })
    expect(relinked.reminderOccurrences.find(item => item.scheduleId === 'second-photo')).toMatchObject({ status: 'satisfied', satisfiedByEntryId: original.id })
  })

  it('synthesizes and satisfies a just-created note occurrence when a win is saved first', () => {
    const noteGoal = goal({ id: 'business', kind: 'qualitative', measurementHistoryId: undefined, evidenceSchedules: [{ id: 'weekly-note', kind: 'note', cadence: 'weekly', firstDueDate: '2026-09-14', active: true }] })
    const fresh = data({ goals: [noteGoal], routines: [], measurementHistories: [], reminderOccurrences: [] })
    const win = { id: 'win-first', title: 'Shipped one test', goalId: noteGoal.id, goalIds: [noteGoal.id], createdAt: iso('2026-09-14'), recordedOn: '2026-09-14' }
    const withWin = { ...fresh, wins: [win] }
    const occurrences = satisfyWinReminderOccurrences(withWin, win)
    const satisfied = { ...withWin, reminderOccurrences: occurrences }
    expect(occurrences).toMatchObject([{ scheduleId: 'weekly-note', status: 'satisfied', satisfiedByEntryId: win.id }])
    expect(dueEvidence(satisfied.goals, satisfied.evidence, '2026-09-20', occurrences, satisfied.progress, satisfied.wins)).toEqual([])
    expect(nextEvidenceDueForSchedule(satisfied, noteGoal.id, 'weekly-note')).toBe('2026-09-21')
  })

  it('deduplicates only explicitly shared histories and chooses the earliest deadline deterministically', () => {
    const near = goal({
      id: 'body-1m',
      area: 'Body',
      unit: 'lbs',
      deadline: '2026-10-01',
      measurementHistoryId: 'measurement:shared:weight',
      evidenceSchedules: [{ id: 'body-1m-number', kind: 'number', cadence: 'weekly', historyId: 'measurement:shared:weight', active: true }],
    })
    const far = goal({
      id: 'body-6m',
      area: ' body ',
      unit: 'LBS',
      deadline: '2027-03-01',
      measurementHistoryId: 'measurement:shared:weight',
      evidenceSchedules: [{ id: 'body-6m-number', kind: 'number', cadence: 'weekly', historyId: 'measurement:shared:weight', active: true }],
    })

    expect(dueEvidence([far, near], [], '2026-09-14')).toMatchObject([
      { goal: near, schedule: near.evidenceSchedules[0], dueDate: '2026-09-01' },
    ])
    const separate = { ...far, measurementHistoryId: 'measurement:other', evidenceSchedules: [{ ...far.evidenceSchedules[0], historyId: 'measurement:other' }] }
    expect(dueEvidence([near, separate], [], '2026-09-14')).toHaveLength(2)
  })

  it('seeds shared Weight and Savings histories without duplicating reminders', () => {
    const seeded = seededGoals(new Date(2026, 8, 14, 12))
    const due = dueEvidence(seeded, [], '2026-09-14')
    expect(due).toHaveLength(3)
    expect(new Set(seeded.filter(goal => goal.unit === 'lbs').map(goal => goal.measurementHistoryId))).toEqual(new Set(['measurement:shared:body-weight']))
    expect(new Set(seeded.filter(goal => goal.unit === 'USD' && goal.title.includes('stacked')).map(goal => goal.measurementHistoryId))).toEqual(new Set(['measurement:shared:savings-balance']))
  })

  it('lets one capture advance every related horizon without hiding unrelated measurements', () => {
    const weight = goal({
      id: 'weight-1m',
      area: 'Body',
      unit: 'lbs',
      measurementHistoryId: 'measurement:shared:weight',
      evidenceSchedules: [{ id: 'weight-weekly', kind: 'number', cadence: 'weekly', historyId: 'measurement:shared:weight', active: true }],
    })
    const laterWeight = goal({
      id: 'weight-6m',
      area: 'Body',
      unit: 'lbs',
      deadline: '2027-03-01',
      measurementHistoryId: 'measurement:shared:weight',
      evidenceSchedules: [{ id: 'later-weight-weekly', kind: 'number', cadence: 'weekly', historyId: 'measurement:shared:weight', active: true }],
    })
    const bodyFat = goal({
      id: 'body-fat',
      area: 'Body',
      unit: '%',
      measurementHistoryId: 'measurement:body-fat',
      evidenceSchedules: [{ id: 'body-fat-weekly', kind: 'number', cadence: 'weekly', historyId: 'measurement:body-fat', active: true }],
    })
    const capture = [{
      id: 'weight-capture',
      goalId: weight.id,
      scheduleId: weight.evidenceSchedules[0].id,
      historyId: 'measurement:shared:weight',
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
    const planning = { anchorMonth: '2026-07-01', trackingStartedOn: '2026-07-01' }
    const first = reconcileSchedule(data({ goals: [], routines: [], wins: [oldWin], planning }), '2026-09-14')
    expect(first.periods.some(item => item.id === 'month:2026-07-01')).toBe(true)
    const second = reconcileSchedule(data({ goals: [], routines: [], wins: [oldWin], periods: first.periods, planning }), '2026-09-14')
    expect(new Set(second.periods.map(item => item.id)).size).toBe(second.periods.length)
  })

  it('assigns a transitive evidence capture to only its canonical recap period', () => {
    const snapshot = data({
      routines: [],
      evidence: [
        { id: 'observation-row', goalId: 'g', observationId: 'observation', kind: 'number', capturedAt: iso('2026-09-30'), recordedOn: '2026-09-30', value: 145 },
        { id: 'bridge-row', goalId: 'g', observationId: 'observation', mediaId: 'receipt', kind: 'photo', capturedAt: iso('2026-10-01'), recordedOn: '2026-10-01' },
        { id: 'milestone-row', goalId: 'g', milestoneId: 'milestone', mediaId: 'receipt', kind: 'milestone', capturedAt: iso('2026-10-02'), recordedOn: '2026-10-02', note: 'One capture' },
      ],
    })

    expect(isRecapEligible(snapshot, periodFor('month', '2026-09-15'), '2026-10-01')).toBe(true)
    expect(isRecapEligible(snapshot, periodFor('month', '2026-10-15'), '2026-11-01')).toBe(false)
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

  it('does not attribute lifetime progress to the current window from one recent observation', () => {
    const oldGoal = goal({
      baseline: 100,
      current: 150,
      target: 200,
      history: [{ at: iso('2026-01-01'), action: 'created', current: 100, target: 200, deadline: '2026-10-01' }],
      createdAt: iso('2026-01-01'),
    })
    const oneRecentObservation = [{ id: 'recent', goalId: oldGoal.id, value: 150, recordedAt: iso('2026-09-10') }]

    expect(calculateMomentum([], [oldGoal], oneRecentObservation, '2026-09-14')).toMatchObject({
      score: 0,
      progress: 0,
      eligibleDays: 0,
    })
  })

  it('does not penalize numeric goals with no update in the window', () => {
    const result = calculateMomentum([task('m', '2026-09-13', 'move', true)], [goal()], [], '2026-09-14')
    expect(result.score).toBe(100)
    expect(result.weights.progress).toBe(0)
  })

  it('scores one explicitly shared observation history only once', () => {
    const near = goal({ id: 'near', measurementHistoryId: 'shared', deadline: '2026-10-01' })
    const far = goal({ id: 'far', measurementHistoryId: 'shared', target: 170, deadline: '2027-03-01' })
    const progress = [
      { id: 'before', goalId: near.id, historyId: 'shared', value: 140, recordedAt: iso('2026-08-31') },
      { id: 'one-update', goalId: near.id, historyId: 'shared', value: 145, recordedAt: iso('2026-09-10') },
    ]
    expect(calculateMomentum([], [near, far], progress, '2026-09-14')).toEqual(calculateMomentum([], [near], progress, '2026-09-14'))
  })

  it('uses the active goal as the representative for a shared history', () => {
    const completedNearTarget = goal({ id: 'near', status: 'completed', measurementHistoryId: 'shared', baseline: 140, current: 150, target: 150, deadline: '2026-10-01' })
    const activeFarTarget = goal({ id: 'far', status: 'active', measurementHistoryId: 'shared', baseline: 140, current: 150, target: 180, deadline: '2027-03-01' })
    const progress = [
      { id: 'before', goalId: completedNearTarget.id, historyId: 'shared', value: 140, recordedAt: iso('2026-08-31') },
      { id: 'one-update', goalId: completedNearTarget.id, historyId: 'shared', value: 150, recordedAt: iso('2026-09-10') },
    ]

    expect(calculateMomentum([], [completedNearTarget, activeFarTarget], progress, '2026-09-14').progress).toBe(25)
  })
})

describe('goal lifecycle', () => {
  it('aligns horizon deadlines to the first of a calendar month', () => {
    const september = new Date(2026, 8, 14, 12)
    expect(deadlineFor('1M', september)).toBe('2026-10-01')
    expect(deadlineFor('3M', september)).toBe('2026-12-01')
    expect(deadlineFor('6M', september)).toBe('2027-03-01')
    expect(deadlineFor('1Y', september)).toBe('2027-09-01')
    expect(deadlineFor('2Y', september)).toBe('2028-09-01')
    const lateLocalSeptember = new Date(2026, 8, 30, 22, 30)
    expect(planningAnchorFor(lateLocalSeptember.toISOString())).toBe('2026-09-01')
    expect(planningAnchorFor('2026-09-30')).toBe('2026-09-01')
  })

  it('creates honest zero-baseline numeric goals at a fixed time', () => {
    const created = createGoal({ title: ' $10k stacked ', horizon: '3M', baseline: 0, target: 10_000, createdAt: iso('2026-09-14') })
    expect(created).toMatchObject({ title: '$10k stacked', kind: 'numeric', baseline: 0, current: 0, direction: 'increase', deadline: '2026-12-01', deadlineAnchor: '2026-09-01', deadlineProvenance: 'calendar-default' })
    expect(created.history[0].at).toBe(iso('2026-09-14'))
  })

  it('edits a numeric target independently from shared observations and preserves custom titles', () => {
    const generated = goal({ title: '140 lbs clean', target: 140, current: 132, baseline: 130, unit: 'lbs', measurementHistoryId: 'measurement:shared:body-weight' })
    const edited = editGoalDetails(generated, { title: generated.title, nextAction: generated.nextAction, target: 135 }, iso('2026-09-18'))
    expect(edited).toMatchObject({ title: '135 lbs clean', target: 135, current: 132, baseline: 130, measurementHistoryId: 'measurement:shared:body-weight' })
    expect(edited.history.at(-1)).toMatchObject({ action: 'adjusted', current: 132, target: 135 })
    expect(goalProgressPercent(edited)).toBeCloseTo(40)

    const custom = editGoalDetails({ ...generated, title: 'Near-term weight checkpoint' }, { title: 'Near-term weight checkpoint', target: 135 }, iso('2026-09-18'))
    expect(custom.title).toBe('Near-term weight checkpoint')
    expect(custom.target).toBe(135)
    expect(editGoalDetails(generated, { title: 'Emergency fund checkpoint', target: 135 })).toMatchObject({ title: 'Emergency fund checkpoint', target: 135 })
    expect(editGoalDetails(custom, { title: '135 lbs clean', target: custom.target })).toMatchObject({ title: '135 lbs clean', target: 135, measurementHistoryId: 'measurement:shared:body-weight' })

    const titleOnly = editGoalDetails(generated, { title: '135 lbs clean' }, iso('2026-09-18'))
    expect(titleOnly.target).toBe(140)
    expect(titleOnly.current).toBe(132)

    const savings = goal({ id: 'savings-1m', title: '$7k stacked', unit: 'USD', target: 7000, current: 2900, baseline: 1000, measurementHistoryId: 'measurement:shared:savings-balance' })
    const savingsEdited = editGoalDetails(savings, { title: savings.title, target: 5000 }, iso('2026-09-18'))
    expect(savingsEdited).toMatchObject({ title: '$5k stacked', target: 5000, current: 2900, measurementHistoryId: 'measurement:shared:savings-balance' })
    expect(savingsEdited.history).toHaveLength(savings.history.length + 1)
  })

  it('adds numeric goals with an explicit history and non-spam capture defaults', () => {
    const existing = goal({ evidenceSchedules: [
      { id: 'existing-number', kind: 'number', cadence: 'weekly', historyId: 'measurement:g', active: true },
      { id: 'existing-photo', kind: 'photo', cadence: 'monthly', historyId: 'measurement:g', active: true },
    ] })
    const snapshot = data({ goals: [existing], progress: [{ id: 'latest', goalId: 'g', historyId: 'measurement:g', value: 146, recordedAt: iso('2026-09-13'), recordedOn: '2026-09-13' }] })
    const linked = goal({ id: 'linked', title: '150 lbs clean', target: 150, current: undefined, baseline: undefined, measurementHistoryId: 'measurement:g', evidenceSchedules: [] })
    const withLinked = addGoalToData(snapshot, linked)
    expect(withLinked.measurementHistories).toHaveLength(snapshot.measurementHistories.length)
    expect(withLinked.goals.at(-1)).toMatchObject({ measurementHistoryId: 'measurement:g', baseline: 146, current: 146 })
    expect(withLinked.goals.at(-1)?.evidenceSchedules).toMatchObject([
      { kind: 'number', cadence: 'weekly', historyId: 'measurement:g', active: true },
      { kind: 'photo', cadence: 'monthly', historyId: 'measurement:g', active: true },
    ])
    expect(dueEvidence(withLinked.goals, [], '2026-09-14')).toHaveLength(2)
    expect(addGoalToData(withLinked, linked)).toBe(withLinked)

    const savings = goal({ id: 'savings', title: '$10k savings', area: 'Money', unit: 'USD', target: 10_000, measurementHistoryId: 'missing', evidenceSchedules: [] })
    const withSavings = addGoalToData(snapshot, savings)
    expect(withSavings.goals.at(-1)?.measurementHistoryId).toBe('measurement:savings')
    expect(withSavings.measurementHistories.at(-1)).toMatchObject({ id: 'measurement:savings', label: 'Savings', semanticKey: 'savings-balance' })
    expect(withSavings.goals.at(-1)?.evidenceSchedules).toMatchObject([
      { kind: 'number', active: true },
      { kind: 'screenshot', active: false },
    ])

    const business = goal({ id: 'business', title: 'Launch a useful business', kind: 'qualitative', area: 'Business', baseline: undefined, current: undefined, target: undefined, unit: undefined, measurementHistoryId: undefined, evidenceSchedules: [] })
    expect(addGoalToData(snapshot, business).goals.at(-1)?.evidenceSchedules).toEqual([])
  })

  it('uses the editable record date for current value and target completion', () => {
    const near = goal({ id: 'near', target: 160, current: 150, measurementHistoryId: 'shared' })
    const far = goal({ id: 'far', target: 170, current: 150, measurementHistoryId: 'shared' })
    const snapshot = data({
      goals: [near, far], routines: [],
      measurementHistories: [{ id: 'shared', label: 'Weight', unit: 'lbs', createdAt: iso('2026-09-01') }],
      progress: [{ id: 'latest', goalId: near.id, historyId: 'shared', value: 150, recordedAt: iso('2026-09-14'), recordedOn: '2026-09-14' }],
    })
    const backfilled = { id: 'backfilled', goalId: near.id, historyId: 'shared', value: 175, recordedAt: iso('2026-09-15'), recordedOn: '2026-09-10' }
    const afterBackfill = recordProgressInData(snapshot, backfilled)
    expect(afterBackfill.goals.map(item => [item.id, item.current, item.status])).toEqual([
      ['near', 150, 'active'],
      ['far', 150, 'active'],
    ])
    expect(recordProgressInData(afterBackfill, backfilled)).toBe(afterBackfill)

    const current = { id: 'current', goalId: near.id, historyId: 'shared', value: 175, recordedAt: iso('2026-09-16'), recordedOn: '2026-09-16' }
    const reached = recordProgressInData(afterBackfill, current)
    expect(reached.goals.map(item => [item.id, item.current, item.status])).toEqual([
      ['near', 175, 'completed'],
      ['far', 175, 'completed'],
    ])
    expect(reached.goals.every(item => localDateOf(item.history.at(-1)!.at) === '2026-09-16')).toBe(true)
  })

  it('previews legacy installation-date corrections and applies only confirmed active goals', () => {
    const candidate = goal({ deadline: '2026-10-14', deadlineProvenance: 'legacy-unknown', createdAt: iso('2026-09-14') })
    const manual = goal({ id: 'manual', deadline: '2026-10-20', deadlineProvenance: 'legacy-unknown', createdAt: iso('2026-09-14') })
    const completed = goal({ id: 'done', deadline: '2026-10-14', deadlineProvenance: 'legacy-unknown', status: 'completed', createdAt: iso('2026-09-14') })
    const snapshot = data({ goals: [candidate, manual, completed], planning: { anchorMonth: '2026-09-01', trackingStartedOn: '2026-09-14' } })
    expect(deadlineCorrectionPreview(snapshot)).toEqual([{ goalId: candidate.id, title: candidate.title, from: '2026-10-14', to: '2026-10-01' }])
    const corrected = confirmDeadlineCorrections(snapshot, [candidate.id], iso('2026-09-15'))
    expect(corrected.goals[0]).toMatchObject({ deadline: '2026-10-01', deadlineProvenance: 'calendar-default', deadlineAnchor: '2026-09-01' })
    expect(corrected.goals[0].history.at(-1)?.action).toBe('adjusted')
    expect(corrected.goals[1].deadline).toBe('2026-10-20')
    expect(corrected.goals[2].deadline).toBe('2026-10-14')
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
    expect(() => reviewDeadline(original, 'continue', 'blocked', { at: iso('2026-10-01'), deadline: '2026-10-01' })).toThrow('after the review date')
    expect(() => reviewDeadline(original, 'adjust', 'blocked', { at: iso('2026-10-01'), deadline: '2026-02-30' })).toThrow('real deadline')
    expect(continued).toMatchObject({ deadlineAnchor: '2026-10-01', deadlineProvenance: 'manual' })
    expect(adjusted).toMatchObject({ deadlineAnchor: '2026-11-01', deadlineProvenance: 'manual' })
  })

  it('corrects a legacy deadline from the goal creation month rather than the app installation month', () => {
    const novemberGoal = goal({
      createdAt: iso('2026-11-15'),
      deadline: '2026-12-15',
      deadlineAnchor: '2026-11-01',
      deadlineProvenance: 'legacy-unknown',
      history: [{ at: iso('2026-11-15'), action: 'created', deadline: '2026-12-15' }],
    })
    const snapshot = data({ goals: [novemberGoal], planning: { anchorMonth: '2026-09-01', trackingStartedOn: '2026-09-14' } })
    expect(deadlineCorrectionPreview(snapshot)).toEqual([{ goalId: 'g', title: 'Weight', from: '2026-12-15', to: '2026-12-01' }])
    expect(confirmDeadlineCorrections(snapshot, ['g'], iso('2026-11-16')).goals[0]).toMatchObject({
      deadline: '2026-12-01',
      deadlineAnchor: '2026-11-01',
      deadlineProvenance: 'calendar-default',
    })
  })

  it('uses lifecycle status for deadline review so reached but reopened goals cannot enter limbo', () => {
    const down = goal({ baseline: 200, current: 150, target: 150, direction: 'decrease', deadline: '2026-09-14' })
    expect(isDeadlineReviewDue(down, '2026-09-14')).toBe(true)
    expect(isDeadlineReviewDue({ ...down, current: 160 }, '2026-09-14')).toBe(true)
    expect(isDeadlineReviewDue(updateNumeric({ ...down, current: 160 }, 150, iso('2026-09-14')), '2026-09-14')).toBe(false)
    expect(isDeadlineReviewDue(resumeGoal({ ...down, status: 'paused' }, iso('2026-09-14')), '2026-09-14')).toBe(true)
    expect(isDeadlineReviewDue(reopenGoal({ ...down, status: 'completed' }, iso('2026-09-14')), '2026-09-14')).toBe(true)
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

  it('honors a partial first period and ignores activity before tracking began', () => {
    const period = periodFor('month', '2026-09-20', '2026-09-01', '2026-09-14')
    const before = data({
      routines: [],
      tasks: [task('before', '2026-09-10', 'move', true)],
      progress: [{ id: 'before-progress', goalId: 'g', historyId: 'measurement:g', value: 142, recordedAt: iso('2026-09-10'), recordedOn: '2026-09-10' }],
      evidence: [{ id: 'before-photo', goalId: 'g', kind: 'photo', capturedAt: iso('2026-09-10'), recordedOn: '2026-09-10' }],
    })
    expect(isMeaningfulRecap(before, period)).toBe(false)
    expect(isRecapEligible(before, { ...period, availableAt: '2026-10-01' }, '2026-10-01')).toBe(false)

    const afterTask = task('after', '2026-09-15', 'move', false)
    const afterProgress = { id: 'after-progress', goalId: 'g', historyId: 'measurement:g', value: 145, recordedAt: iso('2026-09-15'), recordedOn: '2026-09-15' }
    const snapshot = { ...before, tasks: [...before.tasks, afterTask], progress: [...before.progress, afterProgress] }
    const facts = recapFacts(snapshot, period)
    expect(facts.goalMoves).toEqual({ done: 0, due: 1 })
    expect(facts.evidenceCount).toBe(0)
    expect(facts.numeric[0]).toMatchObject({ start: 145, end: 145, observations: 1, hasComparison: false })
    expect(calculateMomentum(snapshot.tasks, snapshot.goals, snapshot.progress, '2026-09-20', { trackingStartedOn: '2026-09-14' })).toEqual(
      calculateMomentum([afterTask], snapshot.goals, [afterProgress], '2026-09-20', { trackingStartedOn: '2026-09-14' }),
    )
  })

  it('keeps completed task history in recaps after soft deletion', () => {
    const period = periodFor('month', '2026-09-20')
    const completedDeleted = task('kept', '2026-09-15', 'move', true, { status: 'deleted', resolvedAt: iso('2026-09-15') })
    const incompleteDeleted = task('hidden', '2026-09-15', 'move', false, { status: 'deleted' })
    const snapshot = data({ routines: [], tasks: [completedDeleted, incompleteDeleted] })
    expect(isMeaningfulRecap(snapshot, period)).toBe(true)
    expect(recapFacts(snapshot, period).goalMoves).toEqual({ done: 1, due: 1 })
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

  it('does not use a goal baseline from before the recap period as period progress', () => {
    const period = periodFor('month', '2026-09-20')
    const oldGoal = goal({
      baseline: 140,
      current: 148,
      createdAt: iso('2026-08-01'),
      history: [{ at: iso('2026-08-01'), action: 'created', current: 140, target: 150, deadline: '2026-10-01' }],
    })
    const facts = recapFacts(data({
      goals: [oldGoal],
      routines: [],
      progress: [
        { id: 'first-this-month', goalId: 'g', value: 145, recordedAt: iso('2026-09-05') },
        { id: 'latest-this-month', goalId: 'g', value: 148, recordedAt: iso('2026-09-15') },
      ],
    }), period)

    expect(facts.numeric[0]).toMatchObject({ start: 145, end: 148, change: 3, observations: 2, hasComparison: true })
  })

  it('orders backfilled measurements by their editable record date, not capture time', () => {
    const period = periodFor('month', '2026-09-20')
    const facts = recapFacts(data({
      routines: [],
      progress: [
        { id: 'captured-later', goalId: 'g', value: 142, recordedAt: iso('2026-09-20'), recordedOn: '2026-09-05' },
        { id: 'recorded-later', goalId: 'g', value: 148, recordedAt: iso('2026-09-15'), recordedOn: '2026-09-15' },
      ],
    }), period)
    expect(facts.numeric[0]).toMatchObject({ start: 140, end: 148, observations: 2 })
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

  it('renders one metric and one evidence count for entries supporting multiple goals', () => {
    const first = goal({ id: 'first', measurementHistoryId: 'shared' })
    const second = goal({ id: 'second', measurementHistoryId: 'shared', target: 170, deadline: '2027-03-01' })
    const snapshot = data({
      goals: [first, second], routines: [],
      measurementHistories: [{ id: 'shared', label: 'Weight', unit: 'lbs', createdAt: iso('2026-09-01') }],
      progress: [{ id: 'measurement', goalId: first.id, historyId: 'shared', value: 145, recordedAt: iso('2026-09-10') }],
      evidence: [
        { id: 'photo-first', goalId: first.id, historyId: 'shared', kind: 'photo', capturedAt: iso('2026-09-10'), mediaId: 'shared-photo' },
        { id: 'photo-second', goalId: second.id, historyId: 'shared', kind: 'photo', capturedAt: iso('2026-09-10'), mediaId: 'shared-photo' },
      ],
    })
    const facts = recapFacts(snapshot, periodFor('month', '2026-09-14'))
    expect(facts.numeric).toHaveLength(1)
    expect(facts.numeric[0]).toMatchObject({ historyId: 'shared', observations: 1 })
    expect(facts.evidenceCount).toBe(1)
  })

  it('assigns shared media to one recap period and keeps milestone meaning with the capture', () => {
    const snapshot = data({
      routines: [],
      planning: { anchorMonth: '2026-08-01', trackingStartedOn: '2026-08-01' },
      evidence: [
        { id: 'photo-copy', goalId: 'g', kind: 'photo', capturedAt: iso('2026-08-31'), recordedOn: '2026-08-31', mediaId: 'one-capture' },
        { id: 'milestone-copy', goalId: 'g', kind: 'milestone', capturedAt: iso('2026-09-01'), recordedOn: '2026-09-01', mediaId: 'one-capture', note: 'Shared-media milestone' },
      ],
    })
    const august = periodFor('month', '2026-08-15')
    const september = periodFor('month', '2026-09-15')

    expect(recapFacts(snapshot, august)).toMatchObject({ evidenceCount: 1, milestones: ['Shared-media milestone'] })
    expect(recapFacts(snapshot, september).evidenceCount).toBe(0)
    expect(isMeaningfulRecap({ ...snapshot, goals: [], tasks: [], progress: [], wins: [] }, september)).toBe(false)
    expect(isRecapEligible({ ...snapshot, goals: [], tasks: [], progress: [], wins: [] }, september, '2026-10-01')).toBe(false)
  })

  it('counts a measurement and its later photo attachment as one underlying evidence event', () => {
    const snapshot = data({
      routines: [],
      progress: [{ id: 'observation', goalId: 'g', historyId: 'measurement:g', value: 145, recordedAt: iso('2026-09-10'), recordedOn: '2026-09-10' }],
      evidence: [
        { id: 'number-metadata', goalId: 'g', kind: 'number', observationId: 'observation', value: 145, capturedAt: iso('2026-09-10'), recordedOn: '2026-09-10' },
        { id: 'photo-attachment', goalId: 'g', kind: 'photo', observationId: 'observation', mediaId: 'photo', capturedAt: iso('2026-09-11'), recordedOn: '2026-09-10' },
      ],
    })
    expect(recapFacts(snapshot, periodFor('month', '2026-09-15')).evidenceCount).toBe(1)
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
    const plan = {
      kind: 'plan',
      goalId: 'g',
      clarifiedGoal: 'x',
      milestones: [],
      suggestions: [{ id: 'suggestion-1', goalId: 'g', title: 'Do it', nextStep: 'Open the draft.', reason: 'It is the next dependency.', estimatedMinutes: 20, existingTaskId: '' }],
      evidenceSuggestions: [],
      goalLinks: [],
      notes: '',
      clarification: { goalId: '', question: '' },
    }
    expect(validateAiResult('plan', plan)).toBe(true)
    expect(validateAiResult('plan', { ...plan, suggestions: [{ ...plan.suggestions[0], estimatedMinutes: 'soon' }] })).toBe(false)
    expect(validateAiResult('plan', { ...plan, suggestions: Array.from({ length: 4 }, (_, index) => ({ ...plan.suggestions[0], id: `suggestion-${index}` })) })).toBe(false)
  })
})
