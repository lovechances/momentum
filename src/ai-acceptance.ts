import type { AiSuggestion } from './ai'
import type { AppData, Task } from './domain'

export type AiAcceptanceRejection =
  | 'invalid-goal'
  | 'missing-existing-task'
  | 'ineligible-existing-task'
  | 'duplicate-today-task'

export type AiAcceptanceDecision =
  | { kind: 'create'; task: Task }
  | { kind: 'update'; task: Task }
  | { kind: 'reject'; reason: AiAcceptanceRejection }

const nextTaskId = (data: AppData, suggestionId: string) => {
  const used = new Set(data.tasks.map(task => task.id))
  const base = `ai-task:${suggestionId}`
  if (!used.has(base)) return base
  let suffix = 2
  while (used.has(`${base}:${suffix}`)) suffix += 1
  return `${base}:${suffix}`
}

/**
 * Resolves an already-validated AI suggestion into one safe persistence action.
 * The caller remains responsible for applying the returned task exactly once.
 */
export function decideAiSuggestionAcceptance(
  data: AppData,
  localDate: string,
  suggestion: AiSuggestion,
  selectedActiveGoalId: string,
  acceptedAt = data.updatedAt,
): AiAcceptanceDecision {
  const selectedGoal = data.goals.find(goal => goal.id === selectedActiveGoalId)
  if (!selectedGoal || selectedGoal.status !== 'active') {
    return { kind: 'reject', reason: 'invalid-goal' }
  }

  const title = suggestion.title.trim()
  const details = suggestion.nextStep.trim()

  if (suggestion.existingTaskId) {
    const existing = data.tasks.find(task => task.id === suggestion.existingTaskId)
    if (!existing) return { kind: 'reject', reason: 'missing-existing-task' }
    if (
      existing.done
      || (existing.status ?? 'active') !== 'active'
      || existing.kind === 'routine'
      || Boolean(existing.sourceRoutineId)
    ) {
      return { kind: 'reject', reason: 'ineligible-existing-task' }
    }

    return {
      kind: 'update',
      task: {
        ...existing,
        title,
        details,
        goalId: selectedGoal.id,
        kind: 'move',
        section: 'Moves That Matter',
        dueDate: localDate,
        done: false,
        status: 'active',
        sourceRoutineId: undefined,
        resolvedAt: undefined,
        rolledToId: undefined,
      },
    }
  }

  const duplicate = data.tasks.some(task =>
    !task.done
    && (task.status ?? 'active') === 'active'
    && task.title.trim().toLocaleLowerCase() === title.toLocaleLowerCase(),
  )
  if (duplicate) return { kind: 'reject', reason: 'duplicate-today-task' }

  return {
    kind: 'create',
    task: {
      id: nextTaskId(data, suggestion.id),
      title,
      details,
      section: 'Moves That Matter',
      done: false,
      kind: 'move',
      goalId: selectedGoal.id,
      dueDate: localDate,
      createdAt: acceptedAt,
      carriedCount: 0,
      status: 'active',
    },
  }
}
