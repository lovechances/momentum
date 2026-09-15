import type { AppData, Evidence, EvidenceCadence, Goal, PeriodRecord, Reminder, Routine, Task } from './domain'
import { localDateOf, now, todayLocal } from './domain'
import { isDeadlineReviewDue } from './goals'

export const dateAtLocalMidnight = (value: string) => new Date(`${value}T00:00:00`)

export const addDays = (date: string, amount: number) => {
  const result = dateAtLocalMidnight(date)
  result.setDate(result.getDate() + amount)
  return todayLocal(result)
}

/** Calendar-aware month addition, clamped to the destination month's last day. */
export const addMonths = (date: string, amount: number) => {
  const result = dateAtLocalMidnight(date)
  const originalDay = result.getDate()
  result.setDate(1)
  result.setMonth(result.getMonth() + amount)
  const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate()
  result.setDate(Math.min(originalDay, lastDay))
  return todayLocal(result)
}

export const startOfWeek = (date: string) => {
  const weekday = dateAtLocalMidnight(date).getDay()
  return addDays(date, -((weekday + 6) % 7))
}
export const endOfWeek = (date: string) => addDays(startOfWeek(date), 6)
export const startOfMonth = (date: string) => `${date.slice(0, 7)}-01`
export const endOfMonth = (date: string) => addDays(addMonths(startOfMonth(date), 1), -1)
export const startOfQuarter = (date: string) => {
  const result = dateAtLocalMidnight(date)
  result.setMonth(Math.floor(result.getMonth() / 3) * 3, 1)
  return todayLocal(result)
}
export const endOfQuarter = (date: string) => addDays(addMonths(startOfQuarter(date), 3), -1)
export const startOfHalf = (date: string) => {
  const result = dateAtLocalMidnight(date)
  result.setMonth(result.getMonth() < 6 ? 0 : 6, 1)
  return todayLocal(result)
}
export const endOfHalf = (date: string) => addDays(addMonths(startOfHalf(date), 6), -1)
export const startOfYear = (date: string) => `${date.slice(0, 4)}-01-01`
export const endOfYear = (date: string) => `${date.slice(0, 4)}-12-31`

export function isRoutineDue(routine: Routine, date: string) {
  if (!routine.active || localDateOf(routine.createdAt) > date) return false
  const weekday = dateAtLocalMidnight(date).getDay()
  if (routine.recurrence.type === 'daily') return true
  if (routine.recurrence.type === 'weekdays') return weekday > 0 && weekday < 6
  return routine.recurrence.weekdays?.includes(weekday) ?? false
}

export const routineTaskId = (routineId: string, date: string) => `routine:${routineId}:${date}`

export function generateRoutineTasks(routines: Routine[], tasks: Task[], date = todayLocal()): Task[] {
  const todayTasks = tasks.filter(task => task.dueDate === date)
  const existingSources = new Set(todayTasks.flatMap(task => task.sourceRoutineId ? [task.sourceRoutineId] : []))
  const existingIds = new Set(todayTasks.map(task => task.id))
  // A schema-1/early schema-2 routine instance may not have sourceRoutineId. Only
  // routine-kind title matching is used for that migration case; a normal task
  // with the same title must not suppress the routine.
  const legacyRoutineTitles = new Set(
    todayTasks
      .filter(task => task.kind === 'routine' && !task.sourceRoutineId)
      .map(task => task.title.trim().toLowerCase()),
  )

  return routines
    .filter(routine => {
      const id = routineTaskId(routine.id, date)
      return isRoutineDue(routine, date)
        && !existingSources.has(routine.id)
        && !existingIds.has(id)
        && !legacyRoutineTitles.has(routine.title.trim().toLowerCase())
    })
    .map(routine => ({
      id: routineTaskId(routine.id, date),
      title: routine.title,
      section: routine.section,
      done: false,
      kind: 'routine',
      goalId: routine.goalId,
      dueDate: date,
      sourceRoutineId: routine.id,
      createdAt: now(),
      carriedCount: 0,
      status: 'active',
    }))
}

/** Keep only unresolved current/future routine instances aligned with a template. */
export function syncRoutineTaskInstances(tasks: Task[], routine: Routine, date = todayLocal()) {
  return tasks.flatMap(task => {
    if (task.sourceRoutineId !== routine.id || task.dueDate < date || task.done || task.resolvedAt) return [task]
    if (!isRoutineDue(routine, task.dueDate)) return []
    return [{ ...task, title: routine.title, section: routine.section, goalId: routine.goalId }]
  })
}

/** Removing a template preserves past/completed history but removes unresolved generated work. */
export function removeRoutineTaskInstances(tasks: Task[], routineId: string, date = todayLocal()) {
  return tasks.filter(task =>
    task.sourceRoutineId !== routineId
    || task.dueDate < date
    || task.done
    || Boolean(task.resolvedAt),
  )
}

/** Reorder generated routine rows without disturbing the positions of one-off work. */
export function orderRoutineTasksForDisplay(tasks: Task[], routines: Routine[]) {
  const order = new Map(routines.map((routine, index) => [routine.id, index]))
  const orderedRoutines = tasks
    .map((task, index) => ({ task, index }))
    .filter(({ task }) => task.sourceRoutineId && order.has(task.sourceRoutineId))
    .sort((left, right) =>
      (order.get(left.task.sourceRoutineId!) ?? Number.MAX_SAFE_INTEGER)
      - (order.get(right.task.sourceRoutineId!) ?? Number.MAX_SAFE_INTEGER)
      || left.index - right.index,
    )
    .map(({ task }) => task)
  let nextRoutine = 0
  return tasks.map(task => task.sourceRoutineId && order.has(task.sourceRoutineId)
    ? orderedRoutines[nextRoutine++]
    : task)
}

/** Every unresolved one-off from before today is recoverable, even after days away. */
export function rolloverCandidates(tasks: Task[], date = todayLocal()) {
  return tasks.filter(task =>
    task.dueDate < date
    && !task.done
    && !task.sourceRoutineId
    && (task.status ?? 'active') === 'active',
  )
}

export function resolveRollover(task: Task, action: 'carry' | 'drop', date = todayLocal(), at = now()) {
  if (task.done || task.sourceRoutineId || (task.status ?? 'active') !== 'active' || task.dueDate >= date) {
    throw new Error('Only an unresolved overdue one-off can be reviewed.')
  }
  if (action === 'drop') {
    return { original: { ...task, status: 'dropped' as const, resolvedAt: at }, next: undefined }
  }
  const nextId = `${task.id}:rollover:${date}`
  return {
    original: { ...task, status: 'rolled' as const, resolvedAt: at, rolledToId: nextId },
    next: {
      ...task,
      id: nextId,
      dueDate: date,
      done: false,
      sourceRoutineId: undefined,
      createdAt: at,
      carriedCount: task.carriedCount + 1,
      status: 'active' as const,
      resolvedAt: undefined,
      rolledToId: undefined,
    },
  }
}

export const nextEvidenceDate = (capturedDate: string, cadence: EvidenceCadence) => {
  if (cadence === 'weekly') return addDays(capturedDate, 7)
  return addMonths(capturedDate, cadence === 'monthly' ? 1 : 3)
}

type EvidenceSchedule = Goal['evidenceSchedules'][number]
type ScheduledEvidence = { goal: Goal; schedule: EvidenceSchedule }
type DueEvidence = ScheduledEvidence & { dueDate: string }

/**
 * Numeric goals in the same area and unit often describe successive horizons of
 * one measurement (for example, 140/150/170 lbs). One capture should advance
 * that measurement track instead of immediately prompting for every horizon.
 * Goals without enough information to establish that relationship stay
 * isolated, as do multiple same-kind schedules deliberately attached to one
 * goal.
 */
function evidenceTrackKey(item: ScheduledEvidence) {
  const { goal, schedule } = item
  const area = goal.area?.trim().toLowerCase()
  const unit = goal.unit?.trim().toLowerCase()
  const sameKindSchedules = goal.evidenceSchedules.filter(candidate =>
    candidate.active
    && candidate.kind === schedule.kind
    && candidate.cadence === schedule.cadence,
  )
  if (goal.kind === 'numeric' && area && unit && sameKindSchedules.length === 1) {
    return JSON.stringify(['numeric', area, unit, schedule.kind, schedule.cadence])
  }
  return JSON.stringify(['goal', goal.id, schedule.id])
}

function compareScheduledEvidence(left: ScheduledEvidence, right: ScheduledEvidence) {
  return left.goal.deadline.localeCompare(right.goal.deadline)
    || left.goal.createdAt.localeCompare(right.goal.createdAt)
    || left.goal.id.localeCompare(right.goal.id)
    || left.schedule.id.localeCompare(right.schedule.id)
}

export function dueEvidence(goals: Goal[], evidence: Evidence[], date = todayLocal()) {
  const scheduled = goals.flatMap(goal =>
    goal.evidenceSchedules
      .filter(schedule => schedule.active)
      .map(schedule => ({ goal, schedule })),
  )
  const tracks = new Map<string, { active: ScheduledEvidence[]; members: ScheduledEvidence[] }>()
  for (const item of scheduled) {
    const key = evidenceTrackKey(item)
    const track = tracks.get(key) ?? { active: [], members: [] }
    track.members.push(item)
    if (item.goal.status === 'active') track.active.push(item)
    tracks.set(key, track)
  }

  const due: DueEvidence[] = []
  for (const track of tracks.values()) {
    if (!track.active.length) continue
    const representative = [...track.active].sort(compareScheduledEvidence)[0]
    const captures = track.members.flatMap(({ goal, schedule }) => {
      const matching = evidence
        .filter(item =>
          item.goalId === goal.id
          && item.kind === schedule.kind
          && (item.scheduleId === undefined || item.scheduleId === schedule.id),
        )
        .map(item => localDateOf(item.capturedAt))
      return schedule.lastCapturedAt
        ? [...matching, localDateOf(schedule.lastCapturedAt)]
        : matching
    })
    const lastCaptured = captures.sort().at(-1)
    const firstDue = track.active
      .map(({ goal, schedule }) => schedule.firstDueDate ?? localDateOf(goal.createdAt))
      .sort()[0]
    const dueDate = lastCaptured
      ? nextEvidenceDate(lastCaptured, representative.schedule.cadence)
      : firstDue
    if (dueDate <= date) due.push({ ...representative, dueDate })
  }

  return due.sort((left, right) =>
    left.dueDate.localeCompare(right.dueDate)
    || compareScheduledEvidence(left, right),
  )
}

export function periodFor(kind: PeriodRecord['kind'], date = todayLocal()): PeriodRecord {
  let start: string
  let end: string
  if (kind === 'week') {
    start = startOfWeek(date)
    end = endOfWeek(date)
  } else if (kind === 'month') {
    start = startOfMonth(date)
    end = endOfMonth(date)
  } else if (kind === '3M') {
    start = startOfQuarter(date)
    end = endOfQuarter(date)
  } else if (kind === '6M') {
    start = startOfHalf(date)
    end = endOfHalf(date)
  } else {
    start = startOfYear(date)
    end = endOfYear(date)
  }
  return { id: `${kind}:${start}`, kind, start, end, availableAt: addDays(end, 1), finalized: false }
}

const within = (value: string, period: PeriodRecord) => value >= period.start && value <= period.end

/** Empty auto-generated periods do not become recap spam. */
export function isRecapEligible(data: AppData, period: PeriodRecord, date = todayLocal()) {
  if (period.availableAt > date || period.end >= date) return false
  const meaningfulTask = data.tasks.some(task =>
    within(task.dueDate, period) && (task.kind !== 'routine' || task.done),
  )
  const progress = data.progress.some(item => within(localDateOf(item.recordedAt), period))
  const evidence = data.evidence.some(item => within(localDateOf(item.capturedAt), period))
  const win = data.wins.some(item => within(localDateOf(item.createdAt), period))
  const lifecycle = data.goals.some(goal => goal.history.some(item =>
    item.action !== 'created' && within(localDateOf(item.at), period),
  ))
  return meaningfulTask || progress || evidence || win || lifecycle
}

function activityDates(data: AppData) {
  return [
    ...data.tasks.map(item => item.dueDate),
    ...data.progress.map(item => localDateOf(item.recordedAt)),
    ...data.evidence.map(item => localDateOf(item.capturedAt)),
    ...data.wins.map(item => localDateOf(item.createdAt)),
    ...data.goals.flatMap(goal => goal.history.map(item => localDateOf(item.at))),
  ].filter(Boolean)
}

function reconcilePeriods(data: AppData, date: string) {
  const kinds = ['week', 'month', '3M', '6M', 'year'] as const
  const periods = [...data.periods]
  const dates = activityDates(data)
  for (const kind of kinds) {
    const current = periodFor(kind, date)
    const previous = periodFor(kind, addDays(current.start, -1))
    for (const anchor of [date, previous.start, ...dates]) {
      if (anchor > date) continue
      const period = periodFor(kind, anchor)
      if (!periods.some(existing => existing.id === period.id)) periods.push(period)
    }
  }
  return periods.sort((a, b) => a.start.localeCompare(b.start) || a.kind.localeCompare(b.kind))
}

export function reconcileSchedule(data: AppData, date = todayLocal()) {
  const newTasks = generateRoutineTasks(data.routines, data.tasks, date)
  const tasks = [...data.tasks, ...newTasks]
  const scheduledData = { ...data, tasks }
  const periods = reconcilePeriods(scheduledData, date)
  const reminders: Reminder[] = []

  if (data.settings.reminders.evidence) {
    for (const item of dueEvidence(data.goals, data.evidence, date)) {
      reminders.push({
        id: `evidence:${item.goal.id}:${item.schedule.id}`,
        kind: 'evidence',
        title: `${item.schedule.cadence[0].toUpperCase() + item.schedule.cadence.slice(1)} ${item.schedule.kind} due`,
        detail: item.goal.title,
        dueDate: item.dueDate,
        action: 'capture',
      })
    }
  }
  if (data.settings.reminders.recap) {
    for (const period of periods.filter(period => !period.finalized && isRecapEligible(scheduledData, period, date))) {
      reminders.push({
        id: `recap:${period.id}`,
        kind: 'recap',
        title: `${period.kind === '3M' ? '3-month' : period.kind === '6M' ? '6-month' : period.kind} recap ready`,
        dueDate: period.availableAt,
        action: 'recap',
      })
    }
  }
  if (data.settings.reminders.deadline) {
    for (const goal of data.goals.filter(goal => isDeadlineReviewDue(goal, date))) {
      reminders.push({
        id: `deadline:${goal.id}`,
        kind: 'deadline',
        title: 'Goal review required',
        detail: goal.title,
        dueDate: goal.deadline,
        action: 'deadline-review',
      })
    }
  }
  const monthStart = startOfMonth(date)
  const firstWeekOfMonth = date <= addDays(monthStart, 6)
  const hasPlannedMove = tasks.some(task => task.kind === 'move' && task.dueDate >= monthStart && task.dueDate <= date)
  if (firstWeekOfMonth && !hasPlannedMove) {
    const label = new Intl.DateTimeFormat('en-US', { month: 'long' }).format(dateAtLocalMidnight(date))
    reminders.push({
      id: `planning:${monthStart}`,
      kind: 'planning',
      title: `${label} planning is ready`,
      detail: 'Review your horizons and choose a Goal Move.',
      dueDate: monthStart,
      action: 'goals',
    })
  }
  const rollover = rolloverCandidates(tasks, date)
  if (rollover.length) {
    reminders.push({
      id: `rollover:${date}`,
      kind: 'rollover',
      title: `${rollover.length} unfinished ${rollover.length === 1 ? 'item needs' : 'items need'} a decision`,
      dueDate: date,
      action: 'rollover',
    })
  }
  if (data.settings.reminders.morning) {
    reminders.push({
      id: `morning:${date}`,
      kind: 'morning',
      title: 'Your day is ready',
      detail: 'Choose your Moves That Matter.',
      dueDate: date,
      action: 'today',
    })
  }

  return { tasks, periods, reminders, generated: newTasks.length }
}
