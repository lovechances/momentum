import type { Goal, GoalDirection, GoalKind, Horizon } from './domain'
import { now, todayLocal } from './domain'

export type DeadlineReason =
  | 'did-not-execute'
  | 'unrealistic'
  | 'priorities-changed'
  | 'blocked'
  | 'no-longer-important'
  | 'other'

const months: Record<Horizon, number> = { '1M': 1, '3M': 3, '6M': 6, '1Y': 12, '2Y': 24 }

function finite(value: number | undefined) {
  return value === undefined || Number.isFinite(value)
}

function inferredDirection(baseline?: number, target?: number): GoalDirection | undefined {
  if (baseline === undefined || target === undefined || baseline === target) return undefined
  return target > baseline ? 'increase' : 'decrease'
}

/** Add a horizon without JavaScript's Jan 31 -> Mar 3 month overflow. */
export function deadlineFor(horizon: Horizon, from = new Date()) {
  const result = new Date(from)
  const originalDay = result.getDate()
  result.setDate(1)
  result.setMonth(result.getMonth() + months[horizon])
  const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate()
  result.setDate(Math.min(originalDay, lastDay))
  return todayLocal(result)
}

export function createGoal(input: {
  title: string
  horizon: Horizon
  kind?: GoalKind
  area?: string
  baseline?: number
  target?: number
  direction?: GoalDirection
  unit?: string
  deadline?: string
  createdAt?: string
  color?: string
}): Goal {
  const title = input.title.trim()
  if (!title) throw new Error('A goal needs a title.')
  if (!finite(input.baseline) || !finite(input.target)) throw new Error('Goal values must be finite numbers.')

  const createdAt = input.createdAt ?? now()
  const from = input.createdAt ? new Date(input.createdAt) : new Date()
  const deadline = input.deadline ?? deadlineFor(input.horizon, from)
  const kind = input.kind ?? (input.baseline !== undefined || input.target !== undefined ? 'numeric' : 'qualitative')
  const direction = input.direction ?? inferredDirection(input.baseline, input.target)

  return {
    id: crypto.randomUUID(),
    title,
    horizon: input.horizon,
    kind,
    area: input.area,
    baseline: input.baseline,
    current: input.baseline,
    target: input.target,
    direction,
    unit: input.unit,
    deadline,
    status: 'active',
    color: input.color ?? 'sky',
    milestones: [],
    links: [],
    history: [{ at: createdAt, action: 'created', current: input.baseline, target: input.target, deadline }],
    evidenceSchedules: [],
    createdAt,
  }
}

export function numericTargetReached(goal: Goal) {
  if (goal.kind !== 'numeric' || goal.current === undefined || goal.target === undefined) return false
  if (goal.current === goal.target) return true
  const direction = goal.direction ?? inferredDirection(goal.baseline, goal.target)
  if (!direction) return false
  return direction === 'increase' ? goal.current >= goal.target : goal.current <= goal.target
}

export function isGoalComplete(goal: Goal) {
  if (goal.status === 'completed') return true
  if (goal.kind === 'numeric') return numericTargetReached(goal)
  if (goal.kind === 'milestone') return goal.milestones.length > 0 && goal.milestones.every(m => m.done)
  return false
}

export function updateNumeric(goal: Goal, value: number, at = now()): Goal {
  if (!Number.isFinite(value)) throw new Error('Progress must be a finite number.')
  const baseline = goal.baseline ?? value
  const direction = goal.direction ?? inferredDirection(baseline, goal.target)
  const candidate = { ...goal, baseline, current: value, direction }
  const newlyCompleted = goal.status !== 'completed' && goal.status !== 'closed' && numericTargetReached(candidate)
  return {
    ...candidate,
    status: newlyCompleted ? 'completed' : goal.status,
    history: [
      ...goal.history,
      {
        at,
        action: newlyCompleted ? 'completed' : 'progressed',
        current: value,
        target: goal.target,
        deadline: goal.deadline,
      },
    ],
  }
}

export function completeGoal(goal: Goal, at = now(), note?: string): Goal {
  if (goal.status === 'completed') return goal
  return {
    ...goal,
    status: 'completed',
    history: [...goal.history, { at, action: 'completed', note, current: goal.current, target: goal.target, deadline: goal.deadline }],
  }
}

export function pauseGoal(goal: Goal, at = now(), note?: string): Goal {
  if (goal.status !== 'active') return goal
  return {
    ...goal,
    status: 'paused',
    history: [...goal.history, { at, action: 'paused', note, current: goal.current, target: goal.target, deadline: goal.deadline }],
  }
}

export function resumeGoal(goal: Goal, at = now(), note?: string): Goal {
  if (goal.status !== 'paused') return goal
  return {
    ...goal,
    status: 'active',
    history: [...goal.history, { at, action: 'resumed', note, current: goal.current, target: goal.target, deadline: goal.deadline }],
  }
}

/** Restore a completed goal for an intentional correction without erasing its attempt. */
export function reopenGoal(goal: Goal, at = now(), note = 'Reopened completed goal'): Goal {
  if (goal.status !== 'completed') return goal
  return {
    ...goal,
    status: 'active',
    history: [...goal.history, { at, action: 'reopened', note, current: goal.current, target: goal.target, deadline: goal.deadline }],
  }
}

export function editGoalDetails(goal: Goal, changes: { title: string; nextAction?: string }, at = now()): Goal {
  const title = changes.title.trim()
  if (!title) throw new Error('A goal needs a title.')
  const nextAction = changes.nextAction?.trim() || undefined
  if (title === goal.title && nextAction === goal.nextAction) return goal
  const changed = [title !== goal.title ? `Renamed from “${goal.title}”` : undefined, nextAction !== goal.nextAction ? 'next action updated' : undefined].filter(Boolean).join('; ')
  return {
    ...goal,
    title,
    nextAction,
    history: [...goal.history, { at, action: 'adjusted', note: changed, current: goal.current, target: goal.target, deadline: goal.deadline }],
  }
}

export function setMilestoneDone(goal: Goal, milestoneId: string, done: boolean, at = now()): Goal {
  const existing = goal.milestones.find(m => m.id === milestoneId)
  if (!existing || existing.done === done) return goal
  const milestones = goal.milestones.map(m =>
    m.id === milestoneId ? { ...m, done, completedAt: done ? at : undefined } : m,
  )
  const newlyCompleted = goal.kind === 'milestone'
    && goal.status !== 'completed'
    && goal.status !== 'closed'
    && milestones.length > 0
    && milestones.every(m => m.done)
  return {
    ...goal,
    milestones,
    status: newlyCompleted ? 'completed' : goal.status,
    history: [
      ...goal.history,
      {
        at,
        action: newlyCompleted ? 'completed' : 'milestone',
        note: `${done ? 'Completed' : 'Reopened'} milestone: ${existing.title}`,
        current: goal.current,
        target: goal.target,
        deadline: goal.deadline,
      },
    ],
  }
}

export function reviewDeadline(
  goal: Goal,
  action: 'continue' | 'adjust' | 'close',
  reason: DeadlineReason,
  options: { deadline?: string; target?: number; note?: string; at?: string } = {},
): Goal {
  if (!finite(options.target)) throw new Error('Goal target must be a finite number.')
  const at = options.at ?? now()
  const note = [reason, options.note].filter(Boolean).join(': ')
  if (action === 'close') {
    return {
      ...goal,
      status: 'closed',
      history: [...goal.history, { at, action: 'closed', note, current: goal.current, target: goal.target, deadline: goal.deadline }],
    }
  }

  const deadline = options.deadline ?? deadlineFor(goal.horizon, new Date(at))
  const target = action === 'adjust' ? options.target ?? goal.target : goal.target
  const direction = action === 'adjust' && options.target !== undefined
    ? inferredDirection(goal.baseline, target) ?? goal.direction
    : goal.direction
  return {
    ...goal,
    status: 'active',
    target,
    direction,
    deadline,
    history: [
      ...goal.history,
      {
        at,
        action: action === 'adjust' ? 'adjusted' : 'continued',
        note,
        current: goal.current,
        target,
        deadline,
      },
    ],
  }
}

export const isDeadlineReviewDue = (goal: Goal, date = todayLocal()) =>
  goal.status === 'active' && goal.deadline <= date && !isGoalComplete(goal)
