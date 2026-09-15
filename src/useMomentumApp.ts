import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppData, Evidence, Goal, MediaRecord, ProgressEntry, Routine, Task, Win } from './domain'
import { now, todayLocal } from './domain'
import { migrateSnapshot } from './migrations'
import { createInitialData } from './seed'
import { currentSnapshotGeneration, readSnapshot, writeSnapshot } from './storage'
import { reconcileSchedule, removeRoutineTaskInstances, resolveRollover as resolveTaskRollover, syncRoutineTaskInstances } from './scheduler'
import {
  completeGoal as markGoalComplete,
  editGoalDetails,
  pauseGoal as markGoalPaused,
  reopenGoal as markGoalReopened,
  resumeGoal as markGoalResumed,
  setMilestoneDone,
  updateNumeric,
} from './goals'

export function useMomentumApp() {
  const [data, setData] = useState<AppData>(() => createInitialData())
  const [ready, setReady] = useState(false)
  const [storageError, setStorageErrorMessage] = useState<string>()
  const persistenceBlocked = useRef(false)
  const currentDate = useRef(todayLocal())

  // Clearing the visible banner must never turn a failed bootstrap into
  // permission to overwrite a potentially recoverable database with seed data.
  const setStorageError = useCallback((message: string | undefined) => {
    if (message) persistenceBlocked.current = true
    setStorageErrorMessage(message)
  }, [])

  const reconcile = useCallback((source: AppData, date = todayLocal()) => {
    const result = reconcileSchedule(source, date)
    return { ...source, tasks: result.tasks, periods: result.periods, updatedAt: now() }
  }, [])

  useEffect(() => {
    let active = true
    readSnapshot()
      .then(snapshot => {
        if (!active) return
        setData(reconcile(migrateSnapshot(snapshot)))
        setReady(true)
      })
      .catch(() => {
        if (!active) return
        setStorageError('Local storage could not be opened. You can continue temporarily or clear local data in Settings.')
        setData(reconcile(createInitialData()))
        setReady(true)
      })
    return () => { active = false }
  }, [reconcile])

  useEffect(() => {
    if (!ready || persistenceBlocked.current) return
    const generation = currentSnapshotGeneration()
    const timer = window.setTimeout(() => {
      writeSnapshot({ ...data, updatedAt: now() }, generation).catch(() => setStorageError('Changes could not be saved on this device. Export a backup before closing the app.'))
    }, 80)
    return () => window.clearTimeout(timer)
  }, [data, ready, storageError])

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      const nextDate = todayLocal()
      if (nextDate !== currentDate.current) {
        currentDate.current = nextDate
        setData(source => reconcile(source, nextDate))
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => { document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('focus', onVisible) }
  }, [reconcile])

  useEffect(() => {
    let timer = 0
    const scheduleNextDay = () => {
      const nextMidnight = new Date()
      nextMidnight.setHours(24, 0, 1, 0)
      timer = window.setTimeout(() => {
        const nextDate = todayLocal()
        if (nextDate !== currentDate.current) {
          currentDate.current = nextDate
          setData(source => reconcile(source, nextDate))
        }
        scheduleNextDay()
      }, Math.max(1_000, nextMidnight.getTime() - Date.now()))
    }
    scheduleNextDay()
    return () => window.clearTimeout(timer)
  }, [reconcile])

  const update = useCallback((fn: (source: AppData) => AppData) => setData(source => ({ ...fn(source), updatedAt: now() })), [])
  const actions = useMemo(() => ({
    finishOnboarding: () => update(source => ({ ...source, onboarded: true })),
    replaceData: (next: AppData) => {
      // The caller invokes this only after replaceDatabase has committed, so a
      // successful restore is also proof that persistence is usable again.
      persistenceBlocked.current = false
      setStorageErrorMessage(undefined)
      setData(reconcile(migrateSnapshot(next)))
    },
    toggleTask: (id: string) => update(source => ({ ...source, tasks: source.tasks.map(task => task.id === id ? { ...task, done: !task.done, resolvedAt: task.done ? undefined : now() } : task) })),
    addTask: (task: Task) => update(source => ({ ...source, tasks: [...source.tasks, task] })),
    updateTask: (task: Task) => update(source => ({ ...source, tasks: source.tasks.map(item => item.id === task.id ? task : item) })),
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
    toggleMilestone: (goalId: string, milestoneId: string, done: boolean) => update(source => ({ ...source, goals: source.goals.map(goal => goal.id === goalId ? setMilestoneDone(goal, milestoneId, done) : goal) })),
    addGoal: (goal: Goal) => update(source => ({ ...source, goals: [...source.goals, goal] })),
    updateRoutine: (routine: Routine) => update(source => {
      const tasks = syncRoutineTaskInstances(source.tasks, routine)
      return reconcile({ ...source, tasks, routines: source.routines.map(item => item.id === routine.id ? routine : item) })
    }),
    addRoutine: (routine: Routine) => update(source => reconcile({ ...source, routines: [...source.routines, routine] })),
    deleteRoutine: (id: string) => update(source => ({ ...source, routines: source.routines.filter(item => item.id !== id), tasks: removeRoutineTaskInstances(source.tasks, id) })),
    reorderRoutine: (id: string, direction: -1 | 1) => update(source => { const routines = [...source.routines]; const index = routines.findIndex(item => item.id === id); const next = index + direction; if (index < 0 || next < 0 || next >= routines.length) return source; [routines[index], routines[next]] = [routines[next], routines[index]]; return { ...source, routines } }),
    addProgress: (entry: ProgressEntry) => update(source => ({ ...source, progress: [...source.progress, entry], goals: source.goals.map(goal => goal.id === entry.goalId ? updateNumeric(goal, entry.value, entry.recordedAt) : goal) })),
    addEvidence: (entry: Evidence) => update(source => ({ ...source, evidence: [...source.evidence, entry], goals: source.goals.map(goal => goal.id === entry.goalId ? { ...goal, evidenceSchedules: goal.evidenceSchedules.map(schedule => (entry.scheduleId ? schedule.id === entry.scheduleId : schedule.kind === entry.kind) ? { ...schedule, lastCapturedAt: entry.capturedAt } : schedule) } : goal) })),
    deleteEvidence: (id: string) => update(source => ({ ...source, evidence: source.evidence.filter(item => item.id !== id) })),
    addWin: (win: Win) => update(source => ({ ...source, wins: [...source.wins, win] })),
    setSettings: (settings: AppData['settings']) => update(source => ({ ...source, settings })),
    setAiUsage: (ai: AppData['settings']['ai']) => update(source => ({ ...source, settings: { ...source.settings, ai } })),
    setPeriodFinalized: (id: string) => update(source => ({ ...source, periods: source.periods.map(period => period.id === id ? { ...period, finalized: true } : period) })),
    reset: () => {
      persistenceBlocked.current = false
      setStorageErrorMessage(undefined)
      setData(reconcile(createInitialData()))
    },
  }), [reconcile, update])

  return { data, ready, storageError, setStorageError, actions }
}

export const newTask = (title: string, kind: Task['kind'], section: Task['section'], goalId?: string): Task => ({ id: crypto.randomUUID(), title: title.trim(), kind, section, goalId, dueDate: todayLocal(), done: false, carriedCount: 0, createdAt: now() })
export const newProgress = (goalId: string, value: number, note?: string): ProgressEntry => ({ id: crypto.randomUUID(), goalId, value, note, recordedAt: now() })
export const newEvidence = (kind: Evidence['kind'], goalId?: string, media?: MediaRecord, note?: string): Evidence => ({ id: crypto.randomUUID(), goalId, kind, mediaId: media?.id, note, capturedAt: now() })
