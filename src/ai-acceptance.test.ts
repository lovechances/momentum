import { describe, expect, it } from 'vitest'
import type { AiSuggestion } from './ai'
import { decideAiSuggestionAcceptance } from './ai-acceptance'
import type { AppData, Goal, Task } from './domain'

const date = '2026-09-15'
const timestamp = '2026-09-15T14:00:00.000Z'

const goal = (id: string, status: Goal['status'] = 'active'): Goal => ({
  id,
  title: id,
  horizon: '1M',
  kind: 'binary',
  deadline: '2026-10-15',
  status,
  color: '#c8ff32',
  milestones: [],
  links: [],
  history: [],
  evidenceSchedules: [],
  createdAt: timestamp,
})

const task = (overrides: Partial<Task> = {}): Task => ({
  id: 'existing',
  title: 'Old wording',
  details: 'Old details',
  section: 'Day',
  done: false,
  kind: 'task',
  goalId: 'goal-a',
  dueDate: '2026-09-14',
  createdAt: '2026-09-01T12:00:00.000Z',
  carriedCount: 2,
  status: 'active',
  ...overrides,
})

const data = (tasks: Task[] = []): AppData => ({
  schema: 3,
  goals: [goal('goal-a'), goal('goal-b'), goal('paused', 'paused')],
  tasks,
  routines: [],
  evidence: [],
  wins: [],
  progress: [],
  measurementHistories: [],
  progressLinkSuggestions: [],
  routineExclusions: [],
  reminderOccurrences: [],
  planning: { anchorMonth: '2026-09', trackingStartedOn: date },
  periods: [],
  settings: {
    areas: [],
    ai: { enabled: false, monthlyCap: 1, month: '2026-09', estimatedCost: 0, inputTokens: 0, outputTokens: 0, requests: 0 },
    reminders: { morning: true, evidence: true, recap: true, deadline: true },
  },
  onboarded: true,
  updatedAt: timestamp,
})

const suggestion = (overrides: Partial<AiSuggestion> = {}): AiSuggestion => ({
  id: 'suggestion-1',
  goalId: 'goal-a',
  title: '  Edited action  ',
  nextStep: '  Ship the smallest slice.  ',
  reason: 'It unlocks the next step.',
  estimatedMinutes: 20,
  existingTaskId: '',
  ...overrides,
})

describe('AI suggestion acceptance', () => {
  it('requires the explicitly selected goal to exist and be active', () => {
    expect(decideAiSuggestionAcceptance(data(), date, suggestion(), 'missing')).toEqual({ kind: 'reject', reason: 'invalid-goal' })
    expect(decideAiSuggestionAcceptance(data(), date, suggestion(), 'paused')).toEqual({ kind: 'reject', reason: 'invalid-goal' })
  })

  it('updates an eligible existing task even when it is already due today', () => {
    const existing = task({ dueDate: date, history: [{ at: timestamp, action: 'edited', title: 'Earlier wording' }] })
    const snapshot = data([existing])
    const before = structuredClone(snapshot)

    const decision = decideAiSuggestionAcceptance(snapshot, date, suggestion({ existingTaskId: existing.id }), 'goal-b')

    expect(decision).toEqual({
      kind: 'update',
      task: {
        ...existing,
        title: 'Edited action',
        details: 'Ship the smallest slice.',
        section: 'Moves That Matter',
        done: false,
        kind: 'move',
        goalId: 'goal-b',
        dueDate: date,
        status: 'active',
        sourceRoutineId: undefined,
        resolvedAt: undefined,
        rolledToId: undefined,
      },
    })
    expect(snapshot).toEqual(before)
    expect(decision.kind === 'update' && decision.task).not.toBe(existing)
  })

  it('rejects a nonempty task ID unless it names an unfinished, active, non-routine task', () => {
    expect(decideAiSuggestionAcceptance(data(), date, suggestion({ existingTaskId: 'missing' }), 'goal-a')).toEqual({ kind: 'reject', reason: 'missing-existing-task' })

    const ineligible: Task[] = [
      task({ id: 'done', done: true }),
      task({ id: 'dropped', status: 'dropped' }),
      task({ id: 'routine-kind', kind: 'routine' }),
      task({ id: 'routine-source', sourceRoutineId: 'routine-1' }),
    ]
    for (const candidate of ineligible) {
      expect(decideAiSuggestionAcceptance(data(ineligible), date, suggestion({ existingTaskId: candidate.id }), 'goal-a')).toEqual({ kind: 'reject', reason: 'ineligible-existing-task' })
    }
  })

  it('treats legacy tasks without a status as active and avoids case-only duplicates', () => {
    const legacy = task({ id: 'legacy-status', status: undefined })
    expect(decideAiSuggestionAcceptance(data([legacy]), date, suggestion({ existingTaskId: legacy.id }), 'goal-a').kind).toBe('update')

    const duplicate = task({ id: 'case-duplicate', title: 'edited ACTION', dueDate: date, status: undefined })
    expect(decideAiSuggestionAcceptance(data([duplicate]), date, suggestion(), 'goal-a')).toEqual({ kind: 'reject', reason: 'duplicate-today-task' })
  })

  it('creates exactly one complete Goal Move when no existing task ID is supplied', () => {
    const snapshot = data()
    const before = structuredClone(snapshot)
    expect(decideAiSuggestionAcceptance(snapshot, date, suggestion(), 'goal-b')).toEqual({
      kind: 'create',
      task: {
        id: 'ai-task:suggestion-1',
        title: 'Edited action',
        details: 'Ship the smallest slice.',
        section: 'Moves That Matter',
        done: false,
        kind: 'move',
        goalId: 'goal-b',
        dueDate: date,
        createdAt: timestamp,
        carriedCount: 0,
        status: 'active',
      },
    })
    expect(snapshot).toEqual(before)
  })

  it('rejects an active unfinished same-day exact-title duplicate when the model omitted its ID', () => {
    const exactDuplicate = task({ id: 'same-title', title: 'Edited action', dueDate: date })
    expect(decideAiSuggestionAcceptance(data([exactDuplicate]), date, suggestion(), 'goal-a')).toEqual({ kind: 'reject', reason: 'duplicate-today-task' })

    const completed = task({ id: 'completed', title: 'Edited action', dueDate: date, done: true })
    expect(decideAiSuggestionAcceptance(data([completed]), date, suggestion(), 'goal-a').kind).toBe('create')
  })

  it('does not duplicate an exact-title unfinished task that is awaiting rollover', () => {
    const overdue = task({ id: 'overdue', title: 'EDITED action', dueDate: '2026-09-01' })
    expect(decideAiSuggestionAcceptance(data([overdue]), date, suggestion(), 'goal-a')).toEqual({ kind: 'reject', reason: 'duplicate-today-task' })
  })

  it('chooses a deterministic unused task ID without modifying existing tasks', () => {
    const snapshot = data([
      task({ id: 'ai-task:suggestion-1', title: 'Different task' }),
      task({ id: 'ai-task:suggestion-1:2', title: 'Another task' }),
    ])
    const decision = decideAiSuggestionAcceptance(snapshot, date, suggestion(), 'goal-a')
    expect(decision.kind === 'create' && decision.task.id).toBe('ai-task:suggestion-1:3')
    expect(snapshot.tasks.map(item => item.id)).toEqual(['ai-task:suggestion-1', 'ai-task:suggestion-1:2'])
  })

  it('uses the actual acceptance timestamp when one is supplied', () => {
    const acceptedAt = '2026-09-15T18:45:00.000Z'
    const decision = decideAiSuggestionAcceptance(data(), date, suggestion(), 'goal-a', acceptedAt)
    expect(decision.kind === 'create' && decision.task.createdAt).toBe(acceptedAt)
  })
})
