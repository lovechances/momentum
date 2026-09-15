import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppData, Evidence, EvidenceCadence, Goal, MediaRecord, ProgressEntry, Routine, Task, Win } from './domain'
import { evidenceGoalIds, localDateOf, now, todayLocal } from './domain'
import { confirmProgressLinkSuggestion, dismissProgressLinkSuggestion, migrateSnapshot } from './migrations'
import { createInitialData } from './seed'
import { currentSnapshotGeneration, readSnapshot, StaleSnapshotError, writeSnapshot, writeSnapshotAndMedia } from './storage'
import { excludeRoutineOccurrence, reconcileSchedule, removeRoutineTaskInstances, resolveRollover as resolveTaskRollover, restoreRoutineOccurrence, satisfyProgressReminderOccurrences, satisfyReminderOccurrences, satisfyWinReminderOccurrences, skipReminderInData, snoozeReminderInData, syncRoutineTaskInstances, updateEvidenceInData, updateEvidenceScheduleTrackInData, updateTaskInData } from './scheduler'
import {
  addGoalToData,
  completeGoal as markGoalComplete,
  editGoalDetails,
  pauseGoal as markGoalPaused,
  recordProgressInData,
  reopenGoal as markGoalReopened,
  resumeGoal as markGoalResumed,
  setMilestoneDone,
} from './goals'

function addEvidenceToData(source: AppData, entry: Evidence): AppData {
  const goalIds = evidenceGoalIds(entry).filter(id => source.goals.some(goal => goal.id === id))
  const primaryGoal = source.goals.find(goal => goal.id === goalIds[0])
  const normalized: Evidence = {
    ...entry,
    goalId: goalIds[0],
    goalIds,
    historyId: entry.historyId ?? primaryGoal?.measurementHistoryId,
    recordedOn: entry.recordedOn ?? localDateOf(entry.capturedAt),
  }
  const next = {
    ...source,
    evidence: source.evidence.some(item => item.id === normalized.id)
      ? source.evidence
      : [...source.evidence, normalized],
  }
  return { ...next, reminderOccurrences: satisfyReminderOccurrences(next, normalized) }
}

/** Apply a numeric observation and its companion evidence as one snapshot mutation. */
export function addProgressEvidenceToData(source: AppData, progress: ProgressEntry, evidence: Evidence): AppData {
  const withProgress = recordProgressInData(source, progress)
  const observation = withProgress.progress.find(item => item.id === progress.id)
  if (!observation) return source
  const withProgressReminder = {
    ...withProgress,
    reminderOccurrences: satisfyProgressReminderOccurrences(withProgress, observation),
  }
  return addEvidenceToData(withProgressReminder, {
    ...evidence,
    observationId: evidence.observationId ?? observation.id,
    historyId: evidence.historyId ?? observation.historyId,
    value: evidence.value ?? observation.value,
  })
}

/** Apply an optional planned-milestone completion and its evidence to one snapshot. */
export function addMilestoneEvidenceToData(
  source: AppData,
  goalId: string,
  milestoneId: string | undefined,
  completionAt: string,
  evidence: Evidence,
): AppData {
  const goal = source.goals.find(item => item.id === goalId)
  if (!goal || (milestoneId && !goal.milestones.some(item => item.id === milestoneId))) return source
  const withMilestone = milestoneId
    ? { ...source, goals: source.goals.map(item => item.id === goalId ? setMilestoneDone(item, milestoneId, true, completionAt) : item) }
    : source
  return addEvidenceToData(withMilestone, { ...evidence, milestoneId: milestoneId ?? evidence.milestoneId })
}

export function deleteEvidenceFromData(source: AppData, idOrIds: string | string[]): AppData {
  const ids = new Set(Array.isArray(idOrIds) ? idOrIds : [idOrIds])
  const affectedScheduleIds = new Set(source.evidence
    .filter(item => ids.has(item.id) && item.scheduleId)
    .map(item => item.scheduleId!))
  const evidence = source.evidence.filter(item => !ids.has(item.id))
  const goals = source.goals.map(goal => ({
    ...goal,
    // Current snapshots retain evidence rows as the source of truth for capture
    // dates. Clear only the affected legacy cache; dueEvidence derives the
    // remaining cadence from recordedOn and leaves unrelated schedules intact.
    evidenceSchedules: goal.evidenceSchedules.map(schedule => affectedScheduleIds.has(schedule.id)
      ? { ...schedule, lastCapturedAt: undefined }
      : schedule),
  }))
  return {
    ...source,
    evidence,
    goals,
    reminderOccurrences: source.reminderOccurrences.map(item => item.satisfiedByEntryId && ids.has(item.satisfiedByEntryId)
      ? { ...item, status: 'due', satisfiedByEntryId: undefined, handledAt: undefined }
      : item),
  }
}

const unavailablePersistenceMessage = 'Local storage is unavailable. Open Settings to restore a backup or reset local data before saving media.'

/** Prevent any durable media mutation after bootstrap/persistence has been blocked. */
export function withAvailablePersistence<T>(blocked: boolean, operation: () => Promise<T>): Promise<T> {
  return blocked ? Promise.reject(new Error(unavailablePersistenceMessage)) : operation()
}

function addWinToData(source: AppData, win: Win): AppData {
  const goalIds = evidenceGoalIds(win).filter(id => source.goals.some(goal => goal.id === id))
  const normalized: Win = {
    ...win,
    goalId: goalIds[0],
    goalIds,
    recordedOn: win.recordedOn ?? localDateOf(win.createdAt),
  }
  const next = {
    ...source,
    wins: source.wins.some(item => item.id === win.id) ? source.wins : [...source.wins, normalized],
  }
  return { ...next, reminderOccurrences: satisfyWinReminderOccurrences(next, normalized) }
}

function updateWinInData(source: AppData, win: Win): AppData {
  if (!source.wins.some(item => item.id === win.id)) return source
  const goalIds = evidenceGoalIds(win).filter(id => source.goals.some(goal => goal.id === id))
  const normalized: Win = {
    ...win,
    goalId: goalIds[0],
    goalIds,
    recordedOn: win.recordedOn ?? localDateOf(win.createdAt),
  }
  const next = { ...source, wins: source.wins.map(item => item.id === win.id ? normalized : item) }
  return { ...next, reminderOccurrences: satisfyWinReminderOccurrences(next, normalized) }
}

function unreferencedMediaIds(before: AppData, after: AppData, candidates: Array<string | undefined>) {
  const referencedAfter = new Set([
    ...after.evidence.flatMap(item => item.mediaId ? [item.mediaId] : []),
    ...after.wins.flatMap(item => item.mediaId ? [item.mediaId] : []),
  ])
  const existedBefore = new Set([
    ...before.evidence.flatMap(item => item.mediaId ? [item.mediaId] : []),
    ...before.wins.flatMap(item => item.mediaId ? [item.mediaId] : []),
  ])
  return [...new Set(candidates.filter((id): id is string => Boolean(id)))]
    .filter(id => existedBefore.has(id) && !referencedAfter.has(id))
}

export function useMomentumApp() {
  const [data, setData] = useState<AppData>(() => createInitialData())
  const dataRef = useRef(data)
  const [ready, setReady] = useState(false)
  const [storageError, setStorageErrorMessage] = useState<string>()
  const persistenceBlocked = useRef(false)
  const persistenceRevision = useRef(0)
  const atomicPersistencePending = useRef(0)
  const atomicPersistenceQueue = useRef<Promise<void>>(Promise.resolve())
  const deferredUpdates = useRef<Array<(source: AppData) => AppData>>([])
  const currentDate = useRef(todayLocal())

  // Clearing the visible banner must never turn a failed bootstrap into
  // permission to overwrite a potentially recoverable database with seed data.
  const setStorageError = useCallback((message: string | undefined) => {
    if (message) persistenceBlocked.current = true
    setStorageErrorMessage(message)
  }, [])

  const reconcile = useCallback((source: AppData, date = todayLocal()) => {
    const result = reconcileSchedule(source, date)
    return { ...source, tasks: result.tasks, periods: result.periods, reminderOccurrences: result.reminderOccurrences, updatedAt: now() }
  }, [])

  const applyData = useCallback((next: AppData) => {
    dataRef.current = next
    setData(next)
  }, [])

  const flushDeferredUpdates = useCallback(() => {
    if (atomicPersistencePending.current > 0 || deferredUpdates.current.length === 0) return
    const queued = deferredUpdates.current.splice(0)
    const next = queued.reduce((source, mutation) => mutation(source), dataRef.current)
    applyData({ ...next, updatedAt: now() })
  }, [applyData])

  const update = useCallback((fn: (source: AppData) => AppData) => {
    // Media transactions are intentionally tiny. Holding ordinary mutations for
    // their duration prevents a concurrent debounced snapshot from crossing the
    // atomic evidence/media boundary or being overwritten when it completes.
    if (atomicPersistencePending.current > 0) {
      deferredUpdates.current.push(fn)
      return
    }
    applyData({ ...fn(dataRef.current), updatedAt: now() })
  }, [applyData])

  const updateWithMedia = useCallback((
    mutation: (source: AppData) => { snapshot: AppData; put?: MediaRecord[]; delete?: string[] },
  ) => withAvailablePersistence(persistenceBlocked.current, () => {
    const generation = currentSnapshotGeneration()
    atomicPersistencePending.current += 1
    // Invalidate any debounce created for the pre-transaction snapshot.
    persistenceRevision.current += 1

    const operation = atomicPersistenceQueue.current.then(async () => {
      const result = mutation(dataRef.current)
      const snapshot = { ...result.snapshot, updatedAt: now() }
      await writeSnapshotAndMedia(snapshot, { put: result.put, delete: result.delete }, generation)
      if (generation !== currentSnapshotGeneration()) {
        throw new Error('Local data changed before this capture could be saved. Please try again.')
      }
      applyData(snapshot)
    })
    atomicPersistenceQueue.current = operation.catch(() => undefined)

    return operation.catch(error => {
      if (generation === currentSnapshotGeneration()) {
        setStorageError(error instanceof StaleSnapshotError
          ? error.message
          : 'Changes and media could not be saved together on this device. Export a backup before closing the app.')
      }
      throw error
    }).finally(() => {
      atomicPersistencePending.current -= 1
      flushDeferredUpdates()
    })
  }), [applyData, flushDeferredUpdates, setStorageError])

  useEffect(() => {
    let active = true
    readSnapshot()
      .then(snapshot => {
        if (!active) return
        applyData(reconcile(migrateSnapshot(snapshot)))
        setReady(true)
      })
      .catch(() => {
        if (!active) return
        setStorageError('Local storage could not be opened. You can continue temporarily or clear local data in Settings.')
        applyData(reconcile(createInitialData()))
        setReady(true)
      })
    return () => { active = false }
  }, [applyData, reconcile, setStorageError])

  useEffect(() => {
    if (!ready || persistenceBlocked.current) return
    const generation = currentSnapshotGeneration()
    const revision = ++persistenceRevision.current
    const timer = window.setTimeout(() => {
      if (atomicPersistencePending.current > 0 || revision !== persistenceRevision.current) return
      writeSnapshot({ ...data, updatedAt: now() }, generation).catch(error => setStorageError(error instanceof StaleSnapshotError
        ? error.message
        : 'Changes could not be saved on this device. Export a backup before closing the app.'))
    }, 80)
    return () => window.clearTimeout(timer)
  }, [data, ready, storageError])

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      const nextDate = todayLocal()
      if (nextDate !== currentDate.current) {
        currentDate.current = nextDate
        update(source => reconcile(source, nextDate))
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => { document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('focus', onVisible) }
  }, [reconcile, update])

  useEffect(() => {
    let timer = 0
    const scheduleNextDay = () => {
      const nextMidnight = new Date()
      nextMidnight.setHours(24, 0, 1, 0)
      timer = window.setTimeout(() => {
        const nextDate = todayLocal()
        if (nextDate !== currentDate.current) {
          currentDate.current = nextDate
          update(source => reconcile(source, nextDate))
        }
        scheduleNextDay()
      }, Math.max(1_000, nextMidnight.getTime() - Date.now()))
    }
    scheduleNextDay()
    return () => window.clearTimeout(timer)
  }, [reconcile, update])
  const actions = useMemo(() => ({
    finishOnboarding: () => update(source => ({ ...source, onboarded: true })),
    replaceData: (next: AppData) => {
      // The caller invokes this only after replaceDatabase has committed, so a
      // successful restore is also proof that persistence is usable again.
      persistenceBlocked.current = false
      setStorageErrorMessage(undefined)
      applyData(reconcile(migrateSnapshot(next)))
    },
    toggleTask: (id: string) => update(source => ({ ...source, tasks: source.tasks.map(task => task.id === id ? { ...task, done: !task.done, resolvedAt: task.done ? undefined : now(), history: [...(task.history ?? []), { at: now(), action: task.done ? 'reopened' : 'completed' }] } : task) })),
    addTask: (task: Task) => update(source => ({ ...source, tasks: [...source.tasks, task] })),
    updateTask: (task: Task) => update(source => updateTaskInData(source, task)),
    deleteTask: (id: string) => update(source => ({ ...source, tasks: source.tasks.map(task => task.id === id ? { ...task, status: 'deleted', history: [...(task.history ?? []), { at: now(), action: 'deleted' }] } : task) })),
    restoreTask: (id: string) => update(source => ({ ...source, tasks: source.tasks.map(task => task.id === id && task.status === 'deleted' ? { ...task, status: 'active', history: [...(task.history ?? []), { at: now(), action: 'restored' }] } : task) })),
    removeRoutineOccurrence: (id: string) => update(source => excludeRoutineOccurrence(source, id)),
    restoreRoutineOccurrence: (id: string) => update(source => restoreRoutineOccurrence(source, id)),
    dropTask: (id: string) => update(source => ({ ...source, tasks: source.tasks.map(task => task.id === id ? { ...task, status: 'dropped', resolvedAt: now() } : task) })),
    resolveRollover: (id: string, action: 'carry' | 'drop', date = todayLocal()) => update(source => {
      const task = source.tasks.find(item => item.id === id)
      if (!task) return source
      const result = resolveTaskRollover(task, action, date)
      return { ...source, tasks: source.tasks.map(item => item.id === id ? result.original : item).concat(result.next ? [result.next] : []) }
    }),
    markRestDay: (date: string, rest: boolean) => update(source => ({ ...source, tasks: source.tasks.map(task => task.dueDate === date ? { ...task, lightDay: rest } : task) })),
    updateGoal: (goal: Goal) => update(source => ({ ...source, goals: source.goals.map(item => item.id === goal.id ? goal : item) })),
    editGoal: (id: string, changes: { title: string; nextAction?: string }) => update(source => ({ ...source, goals: source.goals.map(goal => goal.id === id ? editGoalDetails(goal, changes) : goal) })),
    pauseGoal: (id: string) => update(source => ({ ...source, goals: source.goals.map(goal => goal.id === id ? markGoalPaused(goal) : goal) })),
    resumeGoal: (id: string) => update(source => ({ ...source, goals: source.goals.map(goal => goal.id === id ? markGoalResumed(goal) : goal) })),
    completeGoal: (id: string) => update(source => ({ ...source, goals: source.goals.map(goal => goal.id === id ? markGoalComplete(goal) : goal) })),
    reopenGoal: (id: string) => update(source => ({ ...source, goals: source.goals.map(goal => goal.id === id ? markGoalReopened(goal) : goal) })),
    toggleMilestone: (goalId: string, milestoneId: string, done: boolean, at = now()) => update(source => ({ ...source, goals: source.goals.map(goal => goal.id === goalId ? setMilestoneDone(goal, milestoneId, done, at) : goal) })),
    addGoal: (goal: Goal) => update(source => addGoalToData(source, goal)),
    updateRoutine: (routine: Routine) => update(source => {
      const tasks = syncRoutineTaskInstances(source.tasks, routine)
      return reconcile({ ...source, tasks, routines: source.routines.map(item => item.id === routine.id ? routine : item) })
    }),
    addRoutine: (routine: Routine) => update(source => reconcile({ ...source, routines: [...source.routines, routine] })),
    deleteRoutine: (id: string) => update(source => ({ ...source, routines: source.routines.filter(item => item.id !== id), tasks: removeRoutineTaskInstances(source.tasks, id) })),
    reorderRoutine: (id: string, direction: -1 | 1) => update(source => { const routines = [...source.routines]; const index = routines.findIndex(item => item.id === id); const next = index + direction; if (index < 0 || next < 0 || next >= routines.length) return source; [routines[index], routines[next]] = [routines[next], routines[index]]; return { ...source, routines } }),
    addProgress: (entry: ProgressEntry) => update(source => {
      const next = recordProgressInData(source, entry)
      if (next === source) return source
      const observation = next.progress.find(item => item.id === entry.id)!
      return { ...next, reminderOccurrences: satisfyProgressReminderOccurrences(next, observation) }
    }),
    addEvidence: (entry: Evidence) => update(source => addEvidenceToData(source, entry)),
    updateEvidence: (entry: Evidence) => update(source => updateEvidenceInData(source, entry)),
    deleteEvidence: (idOrIds: string | string[]) => update(source => deleteEvidenceFromData(source, idOrIds)),
    addWin: (win: Win) => update(source => addWinToData(source, win)),
    updateWin: (win: Win) => update(source => updateWinInData(source, win)),
    /** Persist a new or edited evidence record and its Blob in one IndexedDB transaction. */
    saveEvidenceWithMedia: (entry: Evidence, media: MediaRecord) => updateWithMedia(source => {
      const prior = source.evidence.find(item => item.id === entry.id)
      const withMedia = { ...entry, mediaId: media.id }
      const snapshot = prior
        ? updateEvidenceInData(source, withMedia)
        : addEvidenceToData(source, withMedia)
      return {
        snapshot,
        put: [media],
        delete: unreferencedMediaIds(source, snapshot, [prior?.mediaId]),
      }
    }),
    /** Persist a numeric observation, companion evidence, and Blob together. */
    saveProgressEvidenceWithMedia: (progress: ProgressEntry, evidence: Evidence, media: MediaRecord) => updateWithMedia(source => {
      const snapshot = addProgressEvidenceToData(source, progress, { ...evidence, mediaId: media.id })
      return { snapshot, put: snapshot === source ? undefined : [media] }
    }),
    /** Persist milestone completion, evidence, and Blob together. */
    saveMilestoneEvidenceWithMedia: (
      goalId: string,
      milestoneId: string | undefined,
      completionAt: string,
      evidence: Evidence,
      media: MediaRecord,
    ) => updateWithMedia(source => {
      const snapshot = addMilestoneEvidenceToData(
        source,
        goalId,
        milestoneId,
        completionAt,
        { ...evidence, mediaId: media.id },
      )
      return { snapshot, put: snapshot === source ? undefined : [media] }
    }),
    /** Delete evidence and any now-orphaned Blobs in the same transaction. */
    deleteEvidenceWithMedia: (idOrIds: string | string[]) => updateWithMedia(source => {
      const ids = new Set(Array.isArray(idOrIds) ? idOrIds : [idOrIds])
      const removedMedia = source.evidence.filter(item => ids.has(item.id)).map(item => item.mediaId)
      const snapshot = deleteEvidenceFromData(source, [...ids])
      return { snapshot, delete: unreferencedMediaIds(source, snapshot, removedMedia) }
    }),
    /** Persist a win and its optional image as one durable unit. */
    saveWinWithMedia: (win: Win, media: MediaRecord) => updateWithMedia(source => {
      const prior = source.wins.find(item => item.id === win.id)
      const withMedia = { ...win, mediaId: media.id }
      const snapshot = prior ? updateWinInData(source, withMedia) : addWinToData(source, withMedia)
      return {
        snapshot,
        put: [media],
        delete: unreferencedMediaIds(source, snapshot, [prior?.mediaId]),
      }
    }),
    confirmProgressLinks: (id: string, goalIds?: string[], confirmReached = false) => update(source => confirmProgressLinkSuggestion(source, id, goalIds, confirmReached)),
    dismissProgressLinks: (id: string) => update(source => dismissProgressLinkSuggestion(source, id)),
    snoozeReminder: (id: string, until: string) => update(source => snoozeReminderInData(source, id, until)),
    skipReminder: (id: string) => update(source => skipReminderInData(source, id)),
    updateEvidenceSchedule: (goalId: string, scheduleId: string, change: { active?: boolean; cadence?: EvidenceCadence; remove?: boolean }) => update(source => updateEvidenceScheduleTrackInData(source, goalId, scheduleId, change)),
    setSettings: (settings: AppData['settings']) => update(source => ({ ...source, settings })),
    setAiUsage: (ai: AppData['settings']['ai']) => update(source => ({ ...source, settings: { ...source.settings, ai } })),
    setPeriodFinalized: (id: string) => update(source => ({ ...source, periods: source.periods.map(period => period.id === id ? { ...period, finalized: true } : period) })),
    reset: () => {
      persistenceBlocked.current = false
      setStorageErrorMessage(undefined)
      applyData(reconcile(createInitialData()))
    },
  }), [applyData, reconcile, update, updateWithMedia])

  return { data, ready, storageError, setStorageError, actions }
}

export const newTask = (title: string, kind: Task['kind'], section: Task['section'], goalId?: string): Task => ({ id: crypto.randomUUID(), title: title.trim(), kind, section, goalId, dueDate: todayLocal(), done: false, carriedCount: 0, createdAt: now() })
export const newProgress = (goalId: string, value: number, note?: string): ProgressEntry => { const recordedAt = now(); return { id: crypto.randomUUID(), goalId, value, note, recordedAt, recordedOn: localDateOf(recordedAt) } }
export const newEvidence = (kind: Evidence['kind'], goalId?: string, media?: MediaRecord, note?: string): Evidence => { const capturedAt = now(); return { id: crypto.randomUUID(), goalId, goalIds: goalId ? [goalId] : [], kind, mediaId: media?.id, note, capturedAt, recordedOn: localDateOf(capturedAt) } }
