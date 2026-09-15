import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle, ArrowDown, ArrowUp, CalendarDays, Camera, Check, ChevronLeft,
  ChevronRight, Circle, CirclePlus, Download, Goal as GoalIcon,
  Image, Layers3, Moon, Pause, Pencil, Plus, RotateCcw, Settings as SettingsIcon,
  Sparkles, Target, Trash2, TrendingUp, Upload, X,
} from 'lucide-react'
import type { AppData, Evidence, EvidenceKind, EvidenceSchedule, Goal, Horizon, PeriodRecord, Routine, Section, Task } from './domain'
import { compareProgressEntries, evidenceGoalIds, localDateOf, now, recordedDateOf, timestampForLocalDate, todayLocal } from './domain'
import { addGoalContextNote, createGoal, deadlineCorrectionPreview, deadlineFor, numericTargetReached, planningAnchorFor, reviewDeadline, type DeadlineReason } from './goals'
import { calculateMomentum } from './momentum'
import { dueEvidence, addDays, evidencePromptWindow, evidenceTrackKey, matchingEvidenceSchedule, nextEvidenceDueForSchedule, orderRoutineTasksForDisplay, reconcileSchedule, rolloverCandidates } from './scheduler'
import { evidenceCaptureGroups, isMeaningfulRecap, recapFacts } from './recap'
import { compressImage } from './media'
import { allMedia, clearAll, getMedia, mediaBytes, replaceDatabase } from './storage'
import { createBackup, restoreMedia, validateBackup } from './backup'
import { AI_MODEL, applyMonthlyReset, canCallAi, recordAiResponse, aiRequest, type AiPlanResult, type AiResult, type AiSuggestion } from './ai'
import { buildPerspectiveAiContext, buildPlanAiContext, buildTodayAiContext } from './ai-context'
import { decideAiSuggestionAcceptance } from './ai-acceptance'
import { newProgress, newTask, useMomentumApp } from './useMomentumApp'
import { progressLinkCompletionPreview } from './migrations'
import { GoalPicker } from './goal-picker'
import { TaskRow } from './task-row'
import { buildMonthlyProgressView, type ProgressFeedEntry } from './progress-feed'

type Tab = 'today' | 'goals' | 'progress' | 'recap'
type Sheet = 'task' | 'goal' | 'routine-list' | 'routine-form' | 'capture' | 'number' | 'media' | 'milestone' | 'win' | 'settings' | 'goal-detail' | 'deadline' | 'deadline-align' | 'evidence' | 'story' | 'momentum' | 'ai' | null
type DueCaptureTarget = { goalIds: string[]; historyId?: string; kind: EvidenceKind; scheduleId: string; reminderId: string }

const horizons: Horizon[] = ['1M', '3M', '6M', '1Y', '2Y']
const sections: Section[] = ['Morning', 'Moves That Matter', 'Day', 'Evening']
const reasons: Array<[DeadlineReason, string]> = [['did-not-execute', "Didn't execute"], ['unrealistic', 'Goal unrealistic'], ['priorities-changed', 'Priorities changed'], ['blocked', 'Blocked'], ['no-longer-important', 'No longer important'], ['other', 'Other']]
const formatDate = (value: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(`${value}T12:00:00`))
const isRealLocalDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && localDateOf(new Date(`${value}T12:00:00`)) === value
const money = (value: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value)
export default function App() {
  const { data, ready, storageError, actions } = useMomentumApp()
  const [tab, setTab] = useState<Tab>('today')
  const [sheet, setSheet] = useState<Sheet>(null)
  const [goalId, setGoalId] = useState<string>()
  const [routineId, setRoutineId] = useState<string>()
  const [taskId, setTaskId] = useState<string>()
  const [evidenceId, setEvidenceId] = useState<string>()
  const [periodId, setPeriodId] = useState<string>()
  const [toast, setToast] = useState<string>()
  const [mediaSize, setMediaSize] = useState(0)
  const [mediaRevision, setMediaRevision] = useState(0)
  const [captureTarget, setCaptureTarget] = useState<{ goalIds?: string[]; historyId?: string; kind?: EvidenceKind; scheduleId?: string; reminderId?: string; observationId?: string; milestoneId?: string; evidenceId?: string; recordedOn?: string }>({})
  const [undo, setUndo] = useState<{ taskId: string; routineOccurrence: boolean }>()
  const [aiState, setAiState] = useState<{ loading: boolean; action?: 'plan' | 'today' | 'week' | 'recap'; result?: AiResult; error?: string }>({ loading: false })
  const aiAbortRef = useRef<AbortController | undefined>(undefined)
  const acceptedAiSuggestionsRef = useRef(new Set<string>())

  useEffect(() => { mediaBytes().then(setMediaSize).catch(() => undefined) }, [data.evidence.length, data.wins.length, mediaRevision])
  useEffect(() => { if (!toast) return; const id = window.setTimeout(() => setToast(undefined), 2800); return () => window.clearTimeout(id) }, [toast])
  useEffect(() => { if (!undo) return; const id = window.setTimeout(() => setUndo(undefined), 5_000); return () => window.clearTimeout(id) }, [undo])
  useEffect(() => {
    const reset = applyMonthlyReset(data.settings.ai)
    if (reset !== data.settings.ai) actions.setAiUsage(reset)
  }, [actions, data.settings.ai])
  useEffect(() => {
    if (sheet !== 'ai') {
      aiAbortRef.current?.abort()
      aiAbortRef.current = undefined
    }
  }, [sheet])

  const date = todayLocal()
  const schedule = useMemo(() => reconcileSchedule(data, date), [data, date])
  const momentum = useMemo(
    () => calculateMomentum(data.tasks, data.goals, data.progress, date, { trackingStartedOn: data.planning.trackingStartedOn }),
    [data.tasks, data.goals, data.progress, data.planning.trackingStartedOn, date],
  )
  const evidenceDue = useMemo(() => data.settings.reminders.evidence ? dueEvidence(data.goals, data.evidence, date, data.reminderOccurrences, data.progress, data.wins) : [], [data.goals, data.evidence, data.progress, data.wins, data.reminderOccurrences, data.settings.reminders.evidence, date])
  const availablePeriods = useMemo(() => data.periods.filter(period => period.availableAt <= date && isMeaningfulRecap(data, period)).sort((a, b) => b.end.localeCompare(a.end)), [data, date])
  const selectedGoal = data.goals.find(goal => goal.id === goalId)
  const selectedRoutine = data.routines.find(routine => routine.id === routineId)
  const selectedTask = data.tasks.find(task => task.id === taskId)
  const selectedEvidence = data.evidence.find(item => item.id === evidenceId)
  const selectedPeriod = data.periods.find(period => period.id === periodId) || availablePeriods[0]

  const openGoal = (id: string) => { setGoalId(id); setSheet('goal-detail') }
  const openRecap = (period: PeriodRecord) => { setPeriodId(period.id); setSheet('story') }
  const openAi = (action: 'plan' | 'today' | 'week' | 'recap', id?: string) => { if (id) setGoalId(id); acceptedAiSuggestionsRef.current.clear(); setAiState({ loading: false, action }); setSheet('ai') }
  const openCapture = (target: { goalIds?: string[]; historyId?: string; kind?: EvidenceKind; scheduleId?: string; reminderId?: string; observationId?: string; milestoneId?: string; evidenceId?: string; recordedOn?: string } = {}) => {
    setCaptureTarget(target)
    setSheet(target.kind === 'number' ? 'number' : target.kind === 'photo' || target.kind === 'screenshot' ? 'media' : target.kind === 'milestone' ? 'milestone' : 'capture')
  }
  const openDeadline = (id: string) => { setGoalId(id); setSheet('deadline') }
  const editTask = (task: Task) => { setTaskId(task.id); setSheet('task') }
  const removeTask = (task: Task) => {
    const routineOccurrence = Boolean(task.sourceRoutineId)
    if (routineOccurrence) actions.removeRoutineOccurrence(task.id)
    else actions.deleteTask(task.id)
    setUndo({ taskId: task.id, routineOccurrence })
    setToast(undefined)
  }
  const stopRoutine = (id: string) => {
    const routine = data.routines.find(item => item.id === id)
    if (!routine || !window.confirm(`Stop “${routine.title}” from appearing in future days? Prior history stays intact.`)) return
    actions.updateRoutine({ ...routine, active: false, stoppedAt: now() })
    setToast('Routine stopped; past history kept')
  }

  const runAi = async (contextData: AppData = data) => {
    const usage = applyMonthlyReset(contextData.settings.ai)
    if (!usage.enabled) { setAiState(state => ({ ...state, error: 'Enable optional AI in Settings first.' })); return }
    if (!canCallAi(usage, 0.01)) { setAiState(state => ({ ...state, error: 'Your monthly AI limit has been reached.' })); return }
    const action = aiState.action || 'plan'
    const contextGoal = selectedGoal && contextData.goals.find(goal => goal.id === selectedGoal.id)
    if (action === 'plan' && !contextGoal) { setAiState(state => ({ ...state, error: 'Choose a goal before asking for a plan.' })); return }
    const context = action === 'plan'
      ? buildPlanAiContext(contextData, contextGoal!, date)
      : action === 'today'
        ? buildTodayAiContext(contextData, date)
        : selectedPeriod
          ? buildPerspectiveAiContext(contextData, selectedPeriod)
          : { contextState: 'supplied' as const, facts: undefined }
    setAiState(state => ({ ...state, loading: true, error: undefined, result: undefined }))
    const controller = new AbortController()
    aiAbortRef.current?.abort()
    aiAbortRef.current = controller
    try {
      const response = await aiRequest(action, context, { signal: controller.signal })
      const outputPlan = response.output
      actions.setAiUsage(recordAiResponse(usage, response.usage))
      setAiState(state => ({ ...state, loading: false, result: outputPlan }))
    } catch (error) {
      const message = error instanceof DOMException && error.name === 'AbortError' ? 'Request canceled.' : error instanceof Error ? error.message : 'AI is unavailable right now.'
      setAiState(state => ({ ...state, loading: false, error: message }))
    } finally {
      if (aiAbortRef.current === controller) aiAbortRef.current = undefined
    }
  }

  const acceptAiAction = (suggestion: AiSuggestion) => {
    if (acceptedAiSuggestionsRef.current.has(suggestion.id)) return false
    const relatedGoalId = suggestion.goalId || selectedGoal?.id
    const decision = decideAiSuggestionAcceptance(data, date, suggestion, relatedGoalId ?? '', now())
    if (decision.kind === 'reject') {
      setToast(decision.reason === 'invalid-goal'
        ? 'Choose an active related goal before adding a Goal Move'
        : decision.reason === 'duplicate-today-task'
          ? 'That unfinished task already exists'
          : 'That referenced task is no longer available to reuse')
      return false
    }
    acceptedAiSuggestionsRef.current.add(suggestion.id)
    if (decision.kind === 'update') actions.updateTask(decision.task)
    else actions.addTask(decision.task)
    setToast(decision.kind === 'update' ? 'Updated on Today' : 'Added to Today')
    return true
  }

  const answerAiClarification = (clarificationGoalId: string, answer: string) => {
    const clean = answer.trim()
    const target = data.goals.find(goal => goal.id === clarificationGoalId && goal.status === 'active')
    if (!target || !clean) return
    const updatedGoal = addGoalContextNote(target, clean)
    actions.updateGoal(updatedGoal)
    const contextData = { ...data, goals: data.goals.map(goal => goal.id === target.id ? updatedGoal : goal) }
    void runAi(contextData)
  }
  const acceptAiTitle = (title: string) => {
    if (!selectedGoal || !title.trim()) return
    actions.editGoal(selectedGoal.id, { title: title.trim(), nextAction: selectedGoal.nextAction })
    setToast('Goal wording updated')
  }
  const acceptAiMilestone = (title: string) => {
    if (!selectedGoal || !title.trim()) return
    actions.updateGoal({ ...selectedGoal, milestones: [...selectedGoal.milestones, { id: crypto.randomUUID(), title: title.trim(), done: false }] })
    setToast('Milestone added')
  }
  const acceptAiEvidence = (suggestion: string) => {
    if (!selectedGoal || !suggestion.trim()) return false
    const lower = suggestion.toLowerCase()
    const kind: EvidenceKind | undefined = lower.includes('screenshot') ? 'screenshot' : lower.includes('photo') || lower.includes('picture') ? 'photo' : lower.includes('milestone') ? 'milestone' : /number|metric|measure|weight|weigh|balance|revenue|amount|total/.test(lower) ? 'number' : /note|check-in|update/.test(lower) ? 'note' : undefined
    const cadence: EvidenceSchedule['cadence'] | undefined = lower.includes('quarter') ? 'quarterly' : lower.includes('month') ? 'monthly' : lower.includes('week') ? 'weekly' : undefined
    if (!kind || !cadence) {
      setToast('Include a cadence and a measurement, photo, screenshot, note, or milestone')
      return false
    }
    if (kind === 'number' && selectedGoal.kind !== 'numeric') {
      setToast('Number reminders require a numeric goal')
      return false
    }
    const matching = matchingEvidenceSchedule(selectedGoal, kind, cadence)
    if (matching) {
      if (matching.active) {
        setToast('That evidence reminder is already active')
        return false
      }
      actions.updateEvidenceSchedule(selectedGoal.id, matching.id, { active: true })
      setToast('Evidence reminder resumed')
      return true
    }
    actions.updateGoal({ ...selectedGoal, evidenceSchedules: [...selectedGoal.evidenceSchedules, { id: crypto.randomUUID(), kind, cadence, historyId: selectedGoal.measurementHistoryId, firstDueDate: todayLocal(), active: true, provenance: 'manual' }] })
    setToast('Evidence reminder added')
    return true
  }
  const acceptAiLink = (value: string) => {
    if (!selectedGoal) return false
    const linked = data.goals.find(goal => goal.id !== selectedGoal.id && (goal.id === value.trim() || goal.title.toLowerCase() === value.trim().toLowerCase()))
    if (!linked) { setToast('Choose a matching goal title before adding this link'); return false }
    if (selectedGoal.links.includes(linked.id)) { setToast('That goal is already linked'); return false }
    actions.updateGoal({ ...selectedGoal, links: [...selectedGoal.links, linked.id] })
    setToast('Goal link added')
    return true
  }

  if (!ready) return <div className="boot"><div className="brand-dot"/><span>Opening Momentum…</span></div>
  if (!data.onboarded) return <Onboarding onDone={actions.finishOnboarding}/>

  return <main className="app-shell">
    <header className="app-top"><div className="brand-dot"/><span>Momentum</span><button aria-label="Open settings" onClick={() => setSheet('settings')}><SettingsIcon size={19}/></button></header>
    {storageError && <div className="error-banner" role="alert"><AlertCircle size={16}/><span>{storageError}</span><button onClick={() => setSheet('settings')}>Open Settings</button></div>}
    <div className="content">
      {tab === 'today' && <TodayScreen data={data} momentum={momentum} evidenceDue={evidenceDue} reminders={schedule.reminders} onToggle={task => actions.toggleTask(task.id)} onAdd={() => { setTaskId(undefined); setSheet('task') }} onEdit={editTask} onDelete={removeTask} onRemoveToday={removeTask} onEditRoutine={id => { setRoutineId(id); setSheet('routine-form') }} onStopRoutine={stopRoutine} onGoal={openGoal} onCapture={() => openCapture()} onDueEvidence={item => openCapture({ goalIds: item.goalIds, historyId: item.historyId, kind: item.kind, scheduleId: item.scheduleId, reminderId: item.reminderId })} onSnoozeEvidence={(id, until) => actions.snoozeReminder(id, until)} onSkipEvidence={id => actions.skipReminder(id)} onDeadline={openDeadline} onPlanning={() => setTab('goals')} onRollover={actions.resolveRollover} onRestDay={actions.markRestDay} onRoutines={() => setSheet('routine-list')} onMomentum={() => setSheet('momentum')} onRecap={openRecap} onAi={() => openAi('today')}/>}
      {tab === 'goals' && <GoalsScreen data={data} onOpen={openGoal} onAdd={() => setSheet('goal')} onReviewCalendar={() => setSheet('deadline-align')}/>}
      {tab === 'progress' && <ProgressScreen data={data} onCapture={() => openCapture()} onCaptureHistory={(historyId, goalIds) => openCapture({ historyId, goalIds, kind: 'number' })} onAttach={entry => openCapture({ goalIds: entry.goalIds, historyId: entry.historyId, kind: 'photo', observationId: entry.source === 'measurement' ? entry.sourceId : undefined, milestoneId: entry.milestoneId, evidenceId: entry.source === 'evidence' ? entry.sourceId : undefined, recordedOn: entry.date })} onGoal={openGoal} onEvidence={() => { setEvidenceId(undefined); setSheet('evidence') }} onConfirmLinks={id => { const reached = progressLinkCompletionPreview(data, id); if (reached.length && !window.confirm(`The shared current value also reaches ${reached.map(item => `“${item.title}”`).join(', ')}. Link the histories and mark ${reached.length === 1 ? 'this goal' : 'these goals'} complete?`)) return; actions.confirmProgressLinks(id, undefined, reached.length > 0) }} onDismissLinks={id => actions.dismissProgressLinks(id)}/>}
      {tab === 'recap' && <RecapScreen data={data} periods={availablePeriods} onOpen={openRecap} onAi={period => { setPeriodId(period.id); openAi(period.kind === 'week' ? 'week' : 'recap') }}/>}
    </div>
    <nav aria-label="Primary">{([{ id: 'today', label: 'Today', icon: CalendarDays }, { id: 'goals', label: 'Goals', icon: GoalIcon }, { id: 'progress', label: 'Progress', icon: TrendingUp }, { id: 'recap', label: 'Recap', icon: Layers3 }] as const).map(item => { const Icon = item.icon; return <button key={item.id} className={tab === item.id ? 'active' : ''} aria-current={tab === item.id ? 'page' : undefined} onClick={() => setTab(item.id)}><Icon size={20}/><span>{item.label}</span></button> })}</nav>
    {sheet && <Sheet key={sheet} onClose={() => setSheet(null)}>
      {sheet === 'task' && <TaskForm goals={data.goals} task={selectedTask} onSave={task => { selectedTask ? actions.updateTask(task) : actions.addTask(task); setTaskId(undefined); setSheet(null); setToast(selectedTask ? 'Task updated' : task.kind === 'move' ? 'Goal Move added' : 'Task added') }}/>}
      {sheet === 'goal' && <GoalForm data={data} onSave={goal => { actions.addGoal(goal); setSheet(null); setToast('Goal added') }}/>}
      {sheet === 'routine-list' && <RoutineManager routines={data.routines} onAdd={() => { setRoutineId(undefined); setSheet('routine-form') }} onEdit={id => { setRoutineId(id); setSheet('routine-form') }} onToggle={routine => actions.updateRoutine({ ...routine, active: !routine.active })} onDelete={async id => { if (window.confirm('Delete this routine? Past task history will remain.')) actions.deleteRoutine(id) }} onMove={actions.reorderRoutine}/>}
      {sheet === 'routine-form' && <RoutineForm routine={selectedRoutine} onBack={() => setSheet('routine-list')} onSave={routine => { selectedRoutine ? actions.updateRoutine(routine) : actions.addRoutine(routine); setSheet('routine-list'); setToast('Routine saved') }}/>}
      {sheet === 'capture' && <CaptureMenu canNumber={captureTarget.historyId ? true : captureTarget.goalIds?.length ? data.goals.some(goal => captureTarget.goalIds!.includes(goal.id) && goal.kind === 'numeric' && goal.status === 'active') : data.goals.some(goal => goal.kind === 'numeric' && goal.status === 'active')} canMilestone={data.goals.some(goal => goal.status === 'active')} onNumber={() => setSheet('number')} onMedia={() => setSheet('media')} onMilestone={() => setSheet('milestone')} onNote={() => setSheet('win')}/>}
      {sheet === 'number' && <NumberForm data={data} initialGoalIds={captureTarget.goalIds} initialHistoryId={captureTarget.historyId} onSave={async (historyId, id, goalIds, value, note, recordedOn, file) => {
        try {
          const linkedGoals = data.goals.filter(goal => goal.measurementHistoryId === historyId && goal.status === 'active')
          const recordedAt = now()
          const entry = { ...newProgress(id, value, note), historyId, recordedAt, recordedOn }
          const isLatest = [...data.progress.filter(item => item.historyId === historyId), entry]
            .sort(compareProgressEntries)
            .at(-1)?.id === entry.id
          const reached = isLatest ? linkedGoals.filter(goal => numericTargetReached({ ...goal, baseline: goal.baseline ?? value, current: value })) : []
          if (reached.length && !window.confirm(`${formatValue(value, linkedGoals[0]?.unit)} reaches ${reached.map(goal => `“${goal.title}”`).join(', ')} and will mark ${reached.length === 1 ? 'it' : 'them'} complete. Save this measurement?`)) return
          const evidence: Evidence = {
            id: crypto.randomUUID(), goalId: goalIds[0], goalIds, historyId, observationId: entry.id,
            scheduleId: captureTarget.kind === 'number' ? captureTarget.scheduleId : undefined,
            kind: file ? 'photo' : 'number', capturedAt: recordedAt, recordedOn, note, value,
          }
          if (file) {
            const media = await compressImage(file)
            await actions.saveProgressEvidenceWithMedia(entry, evidence, media)
            setMediaRevision(revision => revision + 1)
          } else {
            actions.addProgress(entry)
            actions.addEvidence(evidence)
          }
          setCaptureTarget({})
          setSheet(null)
          setToast(reached.length ? 'Measurement saved and target reached' : 'Measurement saved once for linked goals')
        } catch (error) {
          setToast(error instanceof Error ? error.message : 'That measurement could not be saved')
        }
      }}/>}
      {sheet === 'media' && <MediaForm goals={data.goals} initialGoalIds={captureTarget.goalIds} initialKind={captureTarget.kind} initialRecordedOn={captureTarget.recordedOn} onSave={async (kind, goalIds, note, recordedOn, file) => {
        try {
          const media = await compressImage(file)
          const existing = captureTarget.evidenceId
            ? data.evidence.find(item => item.id === captureTarget.evidenceId)
            : captureTarget.milestoneId
              ? data.evidence.find(item => item.milestoneId === captureTarget.milestoneId && evidenceGoalIds(item).some(id => goalIds.includes(id)))
              : undefined
          const evidence: Evidence = existing
            ? { ...existing, goalId: goalIds[0] ?? existing.goalId, goalIds: goalIds.length ? goalIds : evidenceGoalIds(existing), note: note ?? existing.note, recordedOn }
            : { id: crypto.randomUUID(), goalId: goalIds[0], goalIds, historyId: captureTarget.historyId, observationId: captureTarget.observationId, milestoneId: captureTarget.milestoneId, scheduleId: captureTarget.kind === kind ? captureTarget.scheduleId : undefined, kind, capturedAt: now(), recordedOn, note }
          await actions.saveEvidenceWithMedia(evidence, media)
          setMediaRevision(value => value + 1)
          setCaptureTarget({})
          setSheet(null)
          setToast(existing ? 'Photo attached to existing progress' : 'Progress photo saved privately')
        } catch (error) {
          setToast(error instanceof Error ? error.message : 'That image could not be saved')
        }
      }}/>}
      {sheet === 'milestone' && <MilestoneForm goals={data.goals} initialGoalIds={captureTarget.goalIds} onSave={async (id, goalIds, title, recordedOn, milestoneId, file) => {
        try {
          const targetGoal = data.goals.find(goal => goal.id === id && goal.status === 'active')
          if (!targetGoal) return
          const planned = milestoneId ? targetGoal.milestones.find(item => item.id === milestoneId && !item.done) : undefined
          const completesGoal = Boolean(planned && targetGoal.kind === 'milestone' && targetGoal.milestones.every(item => item.id === planned.id || item.done))
          if (completesGoal && !window.confirm(`“${planned!.title}” is the final milestone and will mark “${targetGoal.title}” complete. Save it?`)) return
          const scheduleId = captureTarget.kind === 'milestone' ? captureTarget.scheduleId : undefined
          const evidence: Evidence = { id: crypto.randomUUID(), goalId: goalIds[0], goalIds, scheduleId, kind: 'milestone', capturedAt: now(), recordedOn, note: title, milestoneId: planned?.id }
          const completionAt = timestampForLocalDate(recordedOn)
          if (file) {
            const media = await compressImage(file)
            await actions.saveMilestoneEvidenceWithMedia(id, planned?.id, completionAt, evidence, media)
            setMediaRevision(value => value + 1)
          } else {
            if (planned) actions.toggleMilestone(id, planned.id, true, completionAt)
            actions.addEvidence(evidence)
          }
          setCaptureTarget({})
          setSheet(null)
          setToast(completesGoal ? 'Milestone captured and goal completed' : 'Milestone captured')
        } catch (error) {
          setToast(error instanceof Error ? error.message : 'That milestone could not be saved')
        }
      }}/>}
      {sheet === 'win' && <WinForm goals={data.goals} initialGoalIds={captureTarget.goalIds} onSave={async (mode, value, file) => {
        try {
          const win = { id: crypto.randomUUID(), title: value.title, note: value.note, goalId: value.goalIds[0], goalIds: value.goalIds, createdAt: now(), recordedOn: value.recordedOn }
          const evidence: Evidence = { id: crypto.randomUUID(), goalId: value.goalIds[0], goalIds: value.goalIds, milestoneId: captureTarget.milestoneId, scheduleId: captureTarget.kind === 'note' ? captureTarget.scheduleId : undefined, kind: 'note', capturedAt: now(), recordedOn: value.recordedOn, note: [value.title, value.note].filter(Boolean).join(' — ') }
          if (file) {
            const media = await compressImage(file)
            if (mode === 'win') await actions.saveWinWithMedia(win, media)
            else await actions.saveEvidenceWithMedia(evidence, media)
            setMediaRevision(revision => revision + 1)
          } else if (mode === 'win') actions.addWin(win)
          else actions.addEvidence(evidence)
          setCaptureTarget({})
          setSheet(null)
          setToast(mode === 'win' ? 'Win captured for your recap' : 'Progress note saved')
        } catch (error) {
          setToast(error instanceof Error ? error.message : 'That update could not be saved')
        }
      }}/>}
      {sheet === 'settings' && <SettingsPanel data={data} mediaSize={mediaSize} onRoutines={() => setSheet('routine-list')} onSettings={actions.setSettings} onExport={async includeMedia => { try { const backup = await createBackup(data, includeMedia ? await allMedia() : [], includeMedia); downloadJson(backup, includeMedia ? 'momentum-full-backup.json' : 'momentum-data-backup.json'); setToast('Backup download started') } catch { setToast('Backup could not be created. Your data was not changed.') } }} onImport={async file => { try { if (file.size > 120 * 1024 * 1024) throw new Error('That backup is too large to import safely on this device.'); const parsed = JSON.parse(await file.text()); if (!validateBackup(parsed)) throw new Error('This is not a valid Momentum backup.'); if (!window.confirm(`Replace the data on this device with this ${parsed.media ? 'full' : 'data-only'} backup?`)) return; const media = await restoreMedia(parsed); const snapshot = parsed.media ? parsed.data : { ...parsed.data, evidence: parsed.data.evidence.map(item => ({ ...item, mediaId: undefined })), wins: parsed.data.wins.map(item => ({ ...item, mediaId: undefined })) }; await replaceDatabase(snapshot, media); actions.replaceData(snapshot); setMediaRevision(value => value + 1); setSheet(null); setToast('Backup restored') } catch (error) { setToast(error instanceof Error ? error.message : 'Backup could not be restored. Your existing data is unchanged.') } }} onClear={async () => { if (!window.confirm('Restore Momentum to its first-run starter goals and routines, and permanently delete your tasks, updates, wins, custom goals/routines, and images?')) return; try { await clearAll(); actions.reset(); setMediaRevision(value => value + 1); setSheet(null); setToast('Momentum reset on this device') } catch { setToast('Local data could not be cleared. Nothing else was changed.') } }}/>}
      {sheet === 'goal-detail' && selectedGoal && <GoalDetail goal={selectedGoal} data={data} onChange={goal => goal.title !== selectedGoal.title || goal.nextAction !== selectedGoal.nextAction ? actions.editGoal(selectedGoal.id, { title: goal.title, nextAction: goal.nextAction }) : actions.updateGoal(goal)} onUpdateSchedule={actions.updateEvidenceSchedule} onPause={() => selectedGoal.status === 'paused' ? actions.resumeGoal(selectedGoal.id) : actions.pauseGoal(selectedGoal.id)} onComplete={() => { actions.completeGoal(selectedGoal.id); if (window.confirm('Goal marked complete. Add a photo, note, or win now?')) openCapture({ goalIds: [selectedGoal.id], historyId: selectedGoal.measurementHistoryId }) }} onReopen={() => { if (window.confirm(`Reopen “${selectedGoal.title}” for correction? Its prior completion stays in history.`)) { actions.reopenGoal(selectedGoal.id); setToast('Goal reopened without erasing history') } }} onToggleMilestone={(id, done) => { const completesGoal = done && selectedGoal.kind === 'milestone' && selectedGoal.milestones.every(item => item.id === id || item.done); if (completesGoal && !window.confirm(`This is the final milestone and will mark “${selectedGoal.title}” complete. Continue?`)) return; actions.toggleMilestone(selectedGoal.id, id, done); if (done && window.confirm('Milestone updated. Add a photo or note?')) openCapture({ goalIds: [selectedGoal.id], historyId: selectedGoal.measurementHistoryId, milestoneId: id }) }} onReview={() => setSheet('deadline')} onAi={() => openAi('plan', selectedGoal.id)} onCapture={() => openCapture({ goalIds: [selectedGoal.id], historyId: selectedGoal.measurementHistoryId })}/>}
      {sheet === 'deadline' && selectedGoal && <DeadlineReview goal={selectedGoal} onBack={() => setSheet('goal-detail')} onSave={(action, reason, options) => { actions.updateGoal(reviewDeadline(selectedGoal, action, reason, options)); setSheet(null); setToast('Goal review saved without rewriting history') }}/>}
      {sheet === 'deadline-align' && <DeadlineAlignment data={data} onUseCalendar={goals => { goals.forEach(goal => actions.updateGoal(goal)); setSheet(null); setToast('Confirmed calendar-aligned deadlines') }} onKeepCurrent={goals => { goals.forEach(goal => actions.updateGoal({ ...goal, deadlineProvenance: 'manual' })); setSheet(null); setToast('Current deadlines kept as manual dates') }}/>}
      {sheet === 'evidence' && <EvidenceGallery evidence={data.evidence} goals={data.goals} onDelete={async group => {
        const ids = group.items.map(item => item.id)
        const linkedGoalCount = group.goalIds.length
        const relationshipCopy = linkedGoalCount > 1 ? ` from all ${linkedGoalCount} linked goals` : ''
        if (!window.confirm(`Delete this capture${relationshipCopy}? The related goals and numeric progress history will remain.`)) return
        try {
          const hasMedia = group.items.some(item => item.mediaId)
          await actions.deleteEvidenceWithMedia(ids)
          if (hasMedia) setMediaRevision(value => value + 1)
          setEvidenceId(undefined)
          setToast('Capture deleted')
        } catch {
          setToast('Evidence could not be deleted. Your record was not changed.')
        }
      }} selected={selectedEvidence} onSelect={setEvidenceId}/>}
      {sheet === 'story' && selectedPeriod && <Story data={data} period={selectedPeriod} onAi={() => openAi(selectedPeriod.kind === 'week' ? 'week' : 'recap')} onDone={() => { actions.setPeriodFinalized(selectedPeriod.id); setSheet(null) }}/>}
      {sheet === 'momentum' && <MomentumDetail result={momentum}/>}
      {sheet === 'ai' && <AiPanel state={aiState} settings={data.settings.ai} selectedGoal={aiState.action === 'plan' ? selectedGoal : undefined} goals={data.goals} onRun={() => void runAi()} onCancel={() => aiAbortRef.current?.abort()} onAcceptAction={acceptAiAction} onAcceptTitle={acceptAiTitle} onAcceptMilestone={acceptAiMilestone} onAcceptEvidence={acceptAiEvidence} onAcceptLink={acceptAiLink} onClarification={answerAiClarification} onDismiss={() => { setAiState({ loading: false }); setSheet(null) }}/>}
    </Sheet>}
    {undo && <div className="undo-toast" role="status"><span>{undo.routineOccurrence ? 'Removed from today' : 'Task deleted'}</span><button onClick={() => { undo.routineOccurrence ? actions.restoreRoutineOccurrence(undo.taskId) : actions.restoreTask(undo.taskId); setUndo(undefined); setToast('Task restored exactly as it was') }}>Undo</button></div>}
    {toast && <div className="toast" role="status"><Check size={15}/>{toast}</div>}
  </main>
}

function TodayScreen({ data, momentum, evidenceDue, reminders, onToggle, onAdd, onEdit, onDelete, onRemoveToday, onEditRoutine, onStopRoutine, onGoal, onCapture, onDueEvidence, onSnoozeEvidence, onSkipEvidence, onDeadline, onPlanning, onRollover, onRestDay, onRoutines, onMomentum, onRecap, onAi }: {
  data: AppData
  momentum: ReturnType<typeof calculateMomentum>
  evidenceDue: ReturnType<typeof dueEvidence>
  reminders: ReturnType<typeof reconcileSchedule>['reminders']
  onToggle: (task: Task) => void
  onAdd: () => void
  onEdit: (task: Task) => void
  onDelete: (task: Task) => void
  onRemoveToday: (task: Task) => void
  onEditRoutine: (id: string) => void
  onStopRoutine: (id: string) => void
  onGoal: (id: string) => void
  onCapture: () => void
  onDueEvidence: (target: DueCaptureTarget) => void
  onSnoozeEvidence: (id: string, until: string) => void
  onSkipEvidence: (id: string) => void
  onDeadline: (goalId: string) => void
  onPlanning: () => void
  onRollover: (id: string, action: 'carry' | 'drop', date?: string) => void
  onRestDay: (date: string, rest: boolean) => void
  onRoutines: () => void
  onMomentum: () => void
  onRecap: (period: PeriodRecord) => void
  onAi: () => void
}) {
  const date = todayLocal()
  const tasks = data.tasks.filter(task => task.dueDate === date && (task.status ?? 'active') === 'active')
  const rollovers = rolloverCandidates(data.tasks, date)
  const recapReminders = reminders.filter(item => item.kind === 'recap')
  const deadlineReminders = reminders.filter(item => item.kind === 'deadline')
  const planningReminders = reminders.filter(item => item.kind === 'planning')
  const lightDay = tasks.length > 0 && tasks.every(task => task.lightDay)
  const [showAllDue, setShowAllDue] = useState(false)
  const evidenceWindow = evidencePromptWindow(evidenceDue)
  const shownEvidence = evidenceWindow.visible
  const hiddenDue = Math.max(0, deadlineReminders.length - 2) + Math.max(0, recapReminders.length - 1)
  const reminderTitle = (goal: Goal, kind: EvidenceKind, cadence: string) => {
    if (kind === 'number' && (goal.measurementHistoryId && data.measurementHistories.find(item => item.id === goal.measurementHistoryId)?.semanticKey === 'body-weight')) return `Time for your ${cadence} weight update.`
    if (kind === 'photo' && goal.area === 'Body') return `Your ${cadence} progress photo is due.`
    if (goal.area === 'Business' || goal.kind === 'qualitative') return `Capture what changed in ${goal.title} this week.`
    return `${cadence[0].toUpperCase()}${cadence.slice(1)} ${kind} update due.`
  }
  return <>
    <header className="page-head"><p>{new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date())}</p><h1>Good morning<span className="warm-dot">.</span></h1></header>
    <button className="momentum-card" onClick={onMomentum}><div><span className="label">MOMENTUM</span>{momentum.status === 'building' ? <b className="building">Building baseline</b> : <strong>{momentum.score}</strong>}<small>{momentum.eligibleDays} eligible day{momentum.eligibleDays === 1 ? '' : 's'} · trailing 14 days</small></div><ChevronRight size={17}/></button>
    {(evidenceDue.length > 0 || recapReminders.length > 0 || deadlineReminders.length > 0 || planningReminders.length > 0) && <section className="due-box"><span className="label">DUE FOR YOU</span>
      {deadlineReminders.slice(0, showAllDue ? undefined : 2).map(reminder => <button key={reminder.id} onClick={() => onDeadline(reminder.id.replace('deadline:', ''))}><AlertCircle size={16}/><span><b>{reminder.title}</b><small>{reminder.detail}</small></span><ChevronRight size={15}/></button>)}
      {shownEvidence.map(({ goal, schedule, dueDate, occurrenceId }) => {
        const goalIds = schedule.historyId
          ? data.goals.filter(item => item.measurementHistoryId === schedule.historyId && item.status === 'active').map(item => item.id)
          : [goal.id]
        return <div className="due-capture" key={occurrenceId}>
          <button className="due-capture__main" onClick={() => onDueEvidence({ goalIds, historyId: schedule.historyId, kind: schedule.kind, scheduleId: schedule.id, reminderId: occurrenceId })}><Camera size={16}/><span><b>{reminderTitle(goal, schedule.kind, schedule.cadence)}</b><small>{goal.title} · due {formatDate(dueDate)}</small></span><ChevronRight size={15}/></button>
          <div className="due-capture__actions"><button onClick={() => onSnoozeEvidence(occurrenceId, addDays(date, 1))}>Snooze 1 day</button><button onClick={() => onSkipEvidence(occurrenceId)}>Skip this time</button><button onClick={() => onGoal(goal.id)}>Edit cadence</button></div>
        </div>
      })}
      {evidenceWindow.hiddenCount > 0 && <p className="due-evidence-summary">{evidenceWindow.hiddenCount} more progress check-in{evidenceWindow.hiddenCount === 1 ? '' : 's'}</p>}
      {planningReminders.map(reminder => <button key={reminder.id} onClick={onPlanning}><CalendarDays size={16}/><span><b>{reminder.title}</b><small>{reminder.detail}</small></span><ChevronRight size={15}/></button>)}
      {recapReminders.slice(0, showAllDue ? undefined : 1).map(reminder => { const period = data.periods.find(item => `recap:${item.id}` === reminder.id); return period ? <button key={reminder.id} onClick={() => onRecap(period)}><Layers3 size={16}/><span><b>{reminder.title}</b><small>See the receipts</small></span><ChevronRight size={15}/></button> : null })}
      {(hiddenDue > 0 || showAllDue) && <button className="due-more" aria-expanded={showAllDue} onClick={() => setShowAllDue(value => !value)}>{showAllDue ? 'Show fewer due items' : `Show ${hiddenDue} more due item${hiddenDue === 1 ? '' : 's'}`}</button>}
    </section>}
    {rollovers.length > 0 && <section className="rollover"><span className="label">UNFINISHED</span>{rollovers.map(task => <div key={task.id}><span><b>{task.title}</b><small>{task.carriedCount ? `Moved ${task.carriedCount} time${task.carriedCount === 1 ? '' : 's'}` : `From ${formatDate(task.dueDate)}`}</small></span><div className="rollover-actions"><button aria-label={`Move ${task.title} to today`} onClick={() => onRollover(task.id, 'carry', date)}>Today</button><button aria-label={`Move ${task.title} to tomorrow`} onClick={() => onRollover(task.id, 'carry', addDays(date, 1))}>Tomorrow</button><button aria-label={`Drop ${task.title}`} onClick={() => onRollover(task.id, 'drop', date)}>Drop</button></div></div>)}</section>}
    <div className="today-heading"><span className="section-kicker">TODAY</span><span>{tasks.filter(task => task.done).length}/{tasks.length} done</span></div>
    {sections.map(section => { const group = orderRoutineTasksForDisplay(tasks.filter(task => task.section === section), data.routines); if (!group.length) return null; return <section className={`task-section ${section === 'Moves That Matter' ? 'moves' : ''}`} key={section}><h2>{section}{section === 'Moves That Matter' && <span>Where your day leads</span>}</h2>{group.map(task => <TaskRow key={task.id} task={task} goalTitle={data.goals.find(goal => goal.id === task.goalId)?.title} onToggle={onToggle} onEdit={onEdit} onDelete={onDelete} onRemoveToday={onRemoveToday} onEditRoutine={onEditRoutine} onStopRoutine={onStopRoutine} onOpenGoal={onGoal}/>)}</section> })}
    <button className="add-row" onClick={onAdd}><CirclePlus size={19}/> Add task</button>
    <div className="today-actions"><button onClick={onCapture}><TrendingUp size={15}/> Update progress</button><button onClick={onAi}><Sparkles size={15}/> Suggest today’s moves</button><button onClick={onRoutines}><RotateCcw size={15}/> Manage routines</button><button aria-pressed={lightDay} disabled={!tasks.length} title={!tasks.length ? 'There are no commitments to mark as a light day.' : undefined} onClick={() => onRestDay(date, !lightDay)}><Moon size={15}/> {!tasks.length ? 'No commitments to mark' : lightDay ? 'Resume normal day' : 'Mark light / rest day'}</button></div>
  </>
}

function GoalsScreen({ data, onOpen, onAdd, onReviewCalendar }: { data: AppData; onOpen: (id: string) => void; onAdd: () => void; onReviewCalendar: () => void }) {
  const [horizon, setHorizon] = useState<Horizon>('1M')
  const [showClosed, setShowClosed] = useState(false)
  const closedCount = data.goals.filter(goal => goal.horizon === horizon && goal.status === 'closed').length
  const goals = data.goals.filter(goal => goal.horizon === horizon && (showClosed || goal.status !== 'closed'))
  const uncertainDeadlines = deadlineCorrectionPreview(data)
  return <><header className="page-head goal-head"><p>Planning horizon</p><h1>Goals</h1></header>{uncertainDeadlines.length > 0 && <button className="calendar-preview" onClick={onReviewCalendar}><CalendarDays size={18}/><span><b>Review calendar deadlines</b><small>{uncertainDeadlines.length} existing date{uncertainDeadlines.length === 1 ? '' : 's'} need your confirmation</small></span><ChevronRight size={16}/></button>}<div className="horizons" aria-label="Goal horizon">{horizons.map(item => <button key={item} className={item === horizon ? 'chosen' : ''} aria-pressed={item === horizon} onClick={() => setHorizon(item)}>{item}</button>)}</div><div className="goal-list">{goals.map(goal => <button className="goal-card" key={goal.id} onClick={() => onOpen(goal.id)}><span className={`area-dot ${goal.color}`}/><div><b>{goal.title}</b><small>{goal.status === 'completed' ? 'Completed' : goal.status === 'closed' ? 'Closed · kept in history' : `${goal.area || 'No area'} · ${formatDate(goal.deadline)}`}</small><GoalProgress goal={goal}/></div><ChevronRight size={18}/></button>)}</div>{closedCount > 0 && <button className="secondary wide archive-toggle" aria-pressed={showClosed} onClick={() => setShowClosed(value => !value)}>{showClosed ? 'Hide' : 'Show'} closed goals ({closedCount})</button>}<button className="primary add-goal" onClick={onAdd}><Plus size={18}/> Add a goal</button></>
}

function ProgressScreen({ data, onCapture, onCaptureHistory, onAttach, onGoal, onEvidence, onConfirmLinks, onDismissLinks }: { data: AppData; onCapture: () => void; onCaptureHistory: (historyId: string, goalIds: string[]) => void; onAttach: (entry: ProgressFeedEntry) => void; onGoal: (id: string) => void; onEvidence: () => void; onConfirmLinks: (id: string) => void; onDismissLinks: (id: string) => void }) {
  const [month, setMonth] = useState(todayLocal().slice(0, 7))
  const [showSetup, setShowSetup] = useState(false)
  const view = buildMonthlyProgressView(data, month, { includeUnconfiguredNumericRows: showSetup })
  const captureCount = evidenceCaptureGroups(data).length
  const pendingLinks = data.progressLinkSuggestions.filter(item => item.status === 'pending')
  const moveMonth = (amount: number) => { const date = new Date(`${month}-01T12:00:00`); date.setMonth(date.getMonth() + amount); setMonth(todayLocal(date).slice(0, 7)) }
  const feedLabel = (entry: ProgressFeedEntry) => entry.kind === 'measurement' ? `${entry.title} updated` : entry.kind === 'win' ? entry.title : entry.kind === 'milestone' ? entry.title : entry.kind === 'note' ? 'Progress note' : entry.kind === 'screenshot' ? 'Screenshot added' : 'Photo added'
  return <><header className="page-head progress-head"><div><p>What actually happened</p><h1>Progress</h1></div><button className="primary" onClick={onCapture}><Plus size={16}/> Add progress</button></header>
    {pendingLinks.map(suggestion => <section className="link-confirmation" key={suggestion.id}><span className="label">SUGGESTED SHARED HISTORY</span><h2>Use one {suggestion.label} history?</h2><p>{suggestion.goalIds.flatMap(id => data.goals.find(goal => goal.id === id)?.title ?? []).join(' · ')}</p><small>Your existing observations, baselines, dates, and targets stay intact. Confirm only if these are the same real-world measurement.</small><div><button className="primary" onClick={() => onConfirmLinks(suggestion.id)}>Yes, link them</button><button onClick={() => onDismissLinks(suggestion.id)}>Keep separate</button></div></section>)}
    <div className="month-selector"><button aria-label="Previous month" onClick={() => moveMonth(-1)}><ChevronLeft size={18}/></button><label><span>MONTH</span><input aria-label="Progress month" type="month" value={month} onChange={event => setMonth(event.target.value)}/><b>{view.month.label}</b></label><button aria-label="Next month" onClick={() => moveMonth(1)}><ChevronRight size={18}/></button></div>
    {view.measurementSummaries.length > 0 && <section className="monthly-measurements"><span className="section-kicker">MEASUREMENTS</span>{view.measurementSummaries.map(summary => <article key={summary.historyId}><button className="measurement-copy" onClick={() => onCaptureHistory(summary.historyId, summary.goalIds)}><span><b>{summary.label}</b><small>{summary.goalTitles.slice(0, 2).join(' · ')}{summary.goalTitles.length > 2 ? ` +${summary.goalTitles.length - 2}` : ''}</small></span><strong>{formatValue(summary.latest.value, summary.unit)}</strong></button><ProgressChart entries={summary.points} emptyLabel="No observations this month"/><div className="metric-foot"><span>{summary.observationCount === 0 ? 'No observations this month' : summary.observationCount === 1 ? 'Starting point recorded' : `${summary.observationCount} observations`}</span><span>{summary.observationCount === 0 ? `Last recorded ${formatDate(summary.latest.date)}` : summary.hasComparison ? `${summary.change! >= 0 ? '+' : ''}${formatValue(summary.change!, summary.unit)} · ${summary.comparisonLabel}` : 'No trend yet'}</span></div></article>)}</section>}
    <section className="progress-feed"><div className="feed-heading"><span className="section-kicker">{view.month.label.toUpperCase()}</span><b>{view.entries.length} captured {view.entries.length === 1 ? 'item' : 'items'}</b></div>{view.entries.map(entry => <article key={entry.key}>{entry.mediaId ? <MediaView mediaId={entry.mediaId} defer alt={`${feedLabel(entry)} evidence`}/> : <div className={`feed-icon ${entry.kind}`} aria-hidden="true">{entry.kind === 'measurement' ? <TrendingUp size={18}/> : entry.kind === 'milestone' ? <Check size={18}/> : entry.kind === 'win' ? <Sparkles size={18}/> : entry.kind === 'note' ? <Pencil size={18}/> : <Camera size={18}/>}</div>}<div><span>{formatDate(entry.date)}</span><h3>{feedLabel(entry)}</h3>{entry.kind === 'measurement' && entry.value !== undefined && <strong>{formatValue(entry.value, entry.unit)}</strong>}{entry.note && <p>{entry.note}</p>}{entry.goalIds.length > 0 && <div className="feed-goals">{entry.goalIds.slice(0, 2).map((id, index) => <button key={id} onClick={() => onGoal(id)}>{entry.goalTitles[index]}</button>)}{entry.goalIds.length > 2 && <span>+{entry.goalIds.length - 2}</span>}</div>}{!entry.mediaId && (entry.source === 'measurement' || entry.kind === 'milestone') && <button className="attach-progress" onClick={() => onAttach(entry)}><Camera size={14}/> Attach photo</button>}</div></article>)}{view.isEmpty && <div className="progress-empty"><TrendingUp size={25}/><h2>No progress recorded in {view.month.label}.</h2><p>Measurements, photos, milestones, notes, and wins you capture will appear here.</p><button className="primary" onClick={onCapture}>Add progress</button></div>}</section>
    <button className="setup-toggle" aria-expanded={showSetup} onClick={() => setShowSetup(value => !value)}>{showSetup ? 'Hide tracking setup' : 'Set up tracking'}<ChevronRight size={15}/></button>{showSetup && view.unconfiguredNumericRows.length > 0 && <section className="setup-rows">{view.unconfiguredNumericRows.map(row => <button key={row.historyId} onClick={() => onCaptureHistory(row.historyId, row.goalIds)}><span><b>{row.label}</b><small>{row.targets.length} target{row.targets.length === 1 ? '' : 's'} · no observation yet</small></span><Plus size={16}/></button>)}</section>}
    <button className="evidence-link" onClick={onEvidence}><Camera size={17}/> Evidence library <span>{captureCount} {captureCount === 1 ? 'capture' : 'captures'}</span><ChevronRight size={16}/></button>
  </>
}

function RecapScreen({ data, periods, onOpen, onAi }: { data: AppData; periods: PeriodRecord[]; onOpen: (period: PeriodRecord) => void; onAi: (period: PeriodRecord) => void }) {
  const latest = periods[0] ? recapFacts(data, periods[0]) : undefined
  const latestMoved = latest && (latest.goalMoves.done > 0 || latest.wins.length > 0 || latest.milestones.length > 0 || latest.completedGoals.length > 0 || latest.numeric.some(item => item.hasComparison && item.change !== 0))
  return <><header className="page-head"><p>Your story, in receipts</p><h1>Recap</h1></header>{periods.length ? <><button className="recap-feature" onClick={() => onOpen(periods[0])}><div className="recap-mesh"/><div className="recap-content"><span>{periods[0].kind.toUpperCase()} · {formatDate(periods[0].end)}</span><h2>{latestMoved ? 'You moved.' : 'An honest look.'}</h2><p>Everything here comes from what you actually captured.</p><span className="recap-cta">View Wrapped <ChevronRight size={16}/></span></div></button><div className="recap-title"><span className="section-kicker">AVAILABLE</span></div>{periods.map(period => { const facts = recapFacts(data, period); return <div className="recap-row" key={period.id}><button onClick={() => onOpen(period)}><div className="recap-icon"><Layers3 size={19}/></div><div><b>{periodLabel(period)}</b><small>{facts.goalMoves.done}/{facts.goalMoves.due} Goal Moves · {facts.activeDays} active days</small></div><ChevronRight size={17}/></button><button className="recap-ai" aria-label={`Get perspective on ${periodLabel(period)}`} onClick={() => onAi(period)}><Sparkles size={15}/></button></div>})}</> : <div className="empty-recap"><Layers3 size={28}/><h2>The story starts here.</h2><p>A recap appears after a completed period contains real tasks, progress, evidence, wins, or a goal result.</p></div>}</>
}

function Onboarding({ onDone }: { onDone: () => void }) { const [page, setPage] = useState(0); const pages = [<><div className="welcome-orb"><Target size={37}/></div><p className="eyebrow">WELCOME TO MOMENTUM</p><h1>Make today<br/>move you forward.</h1><p className="intro-copy">Connect where you’re going with what you do every day.</p></>, <><p className="eyebrow">YOUR GOALS</p><h1>Your direction<br/>is already here.</h1><p className="intro-copy">Your current horizons are ready to review. Starting values stay blank until you record them.</p></>, <><p className="eyebrow">YOUR DAY</p><h1>Small foundations.<br/>Real momentum.</h1><p className="intro-copy">Your routine templates are ready and will appear automatically each day.</p></>]; return <main className="onboarding"><div className="onboard-card">{pages[page]}<div className="dots">{pages.map((_, index) => <i className={page === index ? 'current' : ''} key={index}/>)}</div><button className="primary wide" onClick={() => page < pages.length - 1 ? setPage(page + 1) : onDone()}>{page < pages.length - 1 ? 'Continue' : 'Enter Momentum'}<ChevronRight size={18}/></button></div></main> }

function Sheet({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  const modalRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const oldOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusable = () => [...(modalRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') || [])].filter(element => element.offsetParent !== null)
    const frame = window.requestAnimationFrame(() => (modalRef.current?.querySelector<HTMLElement>('[autofocus]') || focusable()[0] || modalRef.current)?.focus())
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return }
      if (event.key !== 'Tab') return
      const elements = focusable()
      if (!elements.length) { event.preventDefault(); modalRef.current?.focus(); return }
      const first = elements[0]
      const last = elements[elements.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { window.cancelAnimationFrame(frame); document.removeEventListener('keydown', onKeyDown); document.body.style.overflow = oldOverflow; previous?.focus() }
  }, [])
  return <div className="overlay" onMouseDown={event => event.target === event.currentTarget && onClose()}><div className="modal" ref={modalRef} role="dialog" aria-modal="true" aria-label="Momentum panel" tabIndex={-1}><div className="grab"/><button className="sheet-x" aria-label="Close panel" onClick={onClose}><X size={18}/></button>{children}</div></div>
}

function TaskForm({ goals, task, onSave }: { goals: Goal[]; task?: Task; onSave: (task: Task) => void }) {
  const [title, setTitle] = useState(task?.title ?? '')
  const [details, setDetails] = useState(task?.details ?? '')
  const [move, setMove] = useState(task?.kind === 'move')
  const [goalId, setGoalId] = useState(task?.goalId ?? '')
  const [section, setSection] = useState<Section>(task?.section === 'Moves That Matter' ? 'Day' : task?.section ?? 'Day')
  const [dueDate, setDueDate] = useState(task?.dueDate ?? todayLocal())
  const save = () => {
    const base = task ?? newTask(title, move ? 'move' : 'task', move ? 'Moves That Matter' : section, goalId || undefined)
    onSave({
      ...base,
      title: title.trim(),
      details: details.trim() || undefined,
      kind: move ? 'move' : task?.sourceRoutineId ? 'routine' : 'task',
      section: move ? 'Moves That Matter' : section,
      goalId: move ? goalId : task?.sourceRoutineId ? task.goalId : undefined,
      sourceRoutineId: move ? undefined : task?.sourceRoutineId,
      dueDate,
    })
  }
  return <div className="sheet form-sheet"><span className="label">{task ? 'EDIT TASK' : 'NEW TASK'}</span><h2>{task ? 'Correct this task.' : 'What needs doing?'}</h2>
    <textarea className="task-title-editor" autoFocus aria-label="Task title" rows={2} value={title} onChange={event => setTitle(event.target.value)} placeholder="e.g. Grocery store"/>
    <textarea aria-label="Optional task details" rows={2} value={details} onChange={event => setDetails(event.target.value)} placeholder="Optional details or done-when"/>
    <label>Scheduled date<input type="date" value={dueDate} onChange={event => setDueDate(event.target.value)}/></label>
    <button className={`toggle ${move ? 'on' : ''}`} aria-pressed={move} onClick={() => { const next = !move; setMove(next); if (!next) setGoalId('') }}><span><Target size={16}/> This is a Goal Move</span><i/></button>
    {move && <GoalPicker goals={goals} value={goalId || undefined} onChange={id => setGoalId(id ?? '')} allowClear={false} required/>}
    {!move && <label>Today section<select aria-label="Today section" value={section} onChange={event => setSection(event.target.value as Section)}>{sections.filter(item => item !== 'Moves That Matter').map(item => <option key={item}>{item}</option>)}</select></label>}
    <button className="primary wide" disabled={!title.trim() || !dueDate || (move && !goalId)} onClick={save}>{task ? 'Save changes' : 'Add to today'}</button>
  </div>
}

function inferGoal(raw: string) {
  const text = raw.trim()
  const horizon: Horizon = /(?:2\s*years?|24\s*months?)/i.test(text) ? '2Y' : /(?:1\s*year|12\s*months?)/i.test(text) ? '1Y' : /6\s*months?/i.test(text) ? '6M' : /3\s*months?/i.test(text) ? '3M' : '1M'
  const moneyMatch = text.match(/\$\s*([\d,.]+)\s*(k)?/i)
  const weightMatch = text.match(/(\d+(?:\.\d+)?)\s*lbs?/i)
  const audienceMatch = text.match(/(\d+(?:\.\d+)?)\s*k\+?\s+(?:on\s+)?(?:platforms?|followers?)/i)
  const target = moneyMatch ? Number(moneyMatch[1].replaceAll(',', '')) * (moneyMatch[2] ? 1000 : 1) : weightMatch ? Number(weightMatch[1]) : audienceMatch ? Number(audienceMatch[1]) * 1000 : undefined
  const area = moneyMatch || /stacked|cash|revenue|profit/i.test(text) ? 'Money' : weightMatch || /gym|body|physique/i.test(text) ? 'Body' : /business|project|buyee|content|platform|online/i.test(text) ? 'Business' : undefined
  const kind: Goal['kind'] = target !== undefined ? 'numeric' : /finish|complete|ship/i.test(text) ? 'binary' : /start|first|launch/i.test(text) ? 'milestone' : /daily|weekly|consistent/i.test(text) ? 'consistency' : 'qualitative'
  return { horizon, target, unit: moneyMatch ? 'USD' : weightMatch ? 'lbs' : audienceMatch ? 'followers' : undefined, area, kind }
}

function GoalForm({ data, onSave }: { data: AppData; onSave: (goal: Goal) => void }) {
  const [title, setTitle] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const inferred = inferGoal(title)
  const [horizon, setHorizon] = useState<Horizon>()
  const [kind, setKind] = useState<Goal['kind']>()
  const [area, setArea] = useState<string>()
  const [baseline, setBaseline] = useState('')
  const [target, setTarget] = useState('')
  const [deadline, setDeadline] = useState('')
  const [historyOverride, setHistoryOverride] = useState<string>()
  const selectedHorizon = horizon || inferred.horizon
  const selectedKind = kind || inferred.kind
  const selectedArea = area ?? inferred.area
  const displayedTarget = selectedKind === 'numeric' ? (target === '' ? inferred.target : Number(target)) : undefined
  const validBaseline = selectedKind !== 'numeric' || baseline === '' || Number.isFinite(Number(baseline))
  const validTarget = selectedKind !== 'numeric' || target === '' || Number.isFinite(Number(target))
  const normalizedTitle = title.trim().toLowerCase()
  const suggestedHistory = selectedKind === 'numeric' ? data.measurementHistories.find(history => !history.mergedIntoId && (
    (inferred.unit === 'lbs' && history.semanticKey === 'body-weight')
    || (inferred.unit === 'USD' && /stacked|savings?/.test(normalizedTitle) && history.semanticKey === 'savings-balance')
    || history.label.trim().toLowerCase() === normalizedTitle
  )) : undefined
  const selectedHistoryId = historyOverride ?? suggestedHistory?.id ?? 'new'
  const historyOptions = data.measurementHistories.filter(history => !history.mergedIntoId && (!inferred.unit || history.unit === inferred.unit))
  return <div className="sheet form-sheet"><span className="label">NEW GOAL</span><h2>What do you want?</h2><input autoFocus aria-label="Goal title" value={title} onChange={event => { setTitle(event.target.value); setHistoryOverride(undefined) }} placeholder="$10k stacked in 3 months"/>{title && <div className="inference"><b>{title}</b><span>{selectedHorizon} · {displayedTarget === undefined ? 'Outcome goal' : `Target ${displayedTarget}`} · {deadline || deadlineFor(selectedHorizon)}</span>{selectedKind === 'numeric' && suggestedHistory && <small>Uses {suggestedHistory.label} progress</small>}</div>}{selectedKind === 'numeric' && historyOptions.length > 0 && <label className="history-choice">Progress history<select aria-label="Progress history" value={selectedHistoryId} onChange={event => setHistoryOverride(event.target.value)}><option value="new">Start a separate history</option>{historyOptions.map(history => <option value={history.id} key={history.id}>Use {history.label} progress</option>)}</select><small>Only use the same history when this is truly the same measurement.</small></label>}<button className="secondary wide" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>{advanced ? 'Hide adjustments' : 'Adjust / More options'}</button>{advanced && <div className="advanced"><label>Horizon<select value={selectedHorizon} onChange={event => setHorizon(event.target.value as Horizon)}>{horizons.map(item => <option key={item}>{item}</option>)}</select></label><label>Goal type<select value={selectedKind} onChange={event => setKind(event.target.value as Goal['kind'])}><option value="numeric">Numeric</option><option value="binary">Done / not done</option><option value="milestone">Milestone</option><option value="consistency">Consistency</option><option value="qualitative">Qualitative</option></select></label><label>Area<select value={selectedArea || ''} onChange={event => setArea(event.target.value)}><option value="">No area</option><option>Money</option><option>Business</option><option>Body</option><option>Life</option></select></label>{selectedKind === 'numeric' && <><label>Starting point<input inputMode="decimal" value={baseline} onChange={event => setBaseline(event.target.value)}/></label><label>Target<input inputMode="decimal" value={target} onChange={event => setTarget(event.target.value)}/></label></>}<label>Deadline<input type="date" value={deadline || deadlineFor(selectedHorizon)} onChange={event => setDeadline(event.target.value)}/></label></div>}<button className="primary wide" disabled={!title.trim() || !validBaseline || !validTarget} onClick={() => { const start = selectedKind === 'numeric' && baseline !== '' ? Number(baseline) : undefined; const finalTarget = selectedKind === 'numeric' && displayedTarget !== undefined && Number.isFinite(displayedTarget) ? displayedTarget : undefined; const color = selectedArea === 'Body' ? 'lime' : selectedArea === 'Money' ? 'gold' : selectedArea === 'Business' ? 'violet' : 'sky'; const goal = createGoal({ title, horizon: selectedHorizon, kind: selectedKind, area: selectedArea, baseline: start, target: finalTarget, unit: selectedKind === 'numeric' ? inferred.unit : undefined, deadline: deadline || undefined, color }); onSave({ ...goal, measurementHistoryId: selectedKind === 'numeric' && selectedHistoryId !== 'new' ? selectedHistoryId : goal.measurementHistoryId }) }}>Looks right</button></div>
}

function RoutineManager({ routines, onAdd, onEdit, onToggle, onDelete, onMove }: { routines: Routine[]; onAdd: () => void; onEdit: (id: string) => void; onToggle: (routine: Routine) => void; onDelete: (id: string) => void; onMove: (id: string, direction: -1 | 1) => void }) { return <div className="sheet"><span className="label">AUTOMATIC TODAY</span><h2>Routines</h2>{routines.map((routine, index) => <div className="manage-row" key={routine.id}><button className={`switch ${routine.active ? 'on' : ''}`} aria-label={`${routine.active ? 'Pause' : 'Resume'} ${routine.title}`} aria-pressed={routine.active} onClick={() => onToggle(routine)}><i/></button><button className="manage-main" onClick={() => onEdit(routine.id)}><b>{routine.title}</b><small>{routine.section} · {recurrenceLabel(routine)}</small></button><button disabled={index === 0} aria-label={`Move ${routine.title} up`} onClick={() => onMove(routine.id, -1)}><ArrowUp size={14}/></button><button disabled={index === routines.length - 1} aria-label={`Move ${routine.title} down`} onClick={() => onMove(routine.id, 1)}><ArrowDown size={14}/></button><button aria-label={`Delete ${routine.title}`} onClick={() => onDelete(routine.id)}><Trash2 size={14}/></button></div>)}<button className="primary wide" onClick={onAdd}><Plus size={17}/> Add routine</button></div> }
function RoutineForm({ routine, onBack, onSave }: { routine?: Routine; onBack: () => void; onSave: (routine: Routine) => void }) { const [title, setTitle] = useState(routine?.title || ''); const [section, setSection] = useState<Section>(routine?.section || 'Morning'); const [recurrence, setRecurrence] = useState<Routine['recurrence']['type']>(routine?.recurrence.type || 'daily'); const [weekdays, setWeekdays] = useState<number[]>(routine?.recurrence.weekdays || [1, 3, 5]); return <div className="sheet form-sheet"><button className="back" onClick={onBack}><ChevronLeft size={16}/> Routines</button><h2>{routine ? 'Edit routine' : 'New routine'}</h2><input autoFocus aria-label="Routine name" value={title} onChange={event => setTitle(event.target.value)} placeholder="Routine name"/><label>Today section<select value={section} onChange={event => setSection(event.target.value as Section)}>{sections.filter(item => item !== 'Moves That Matter').map(item => <option key={item}>{item}</option>)}</select></label><label>Repeats<select value={recurrence} onChange={event => setRecurrence(event.target.value as Routine['recurrence']['type'])}><option value="daily">Every day</option><option value="weekdays">Weekdays</option><option value="weekdays-custom">Specific weekdays</option></select></label>{recurrence === 'weekdays-custom' && <div className="weekday-row" aria-label="Repeat on">{['S','M','T','W','T','F','S'].map((label, day) => <button type="button" key={day} className={weekdays.includes(day) ? 'selected' : ''} aria-label={['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][day]} aria-pressed={weekdays.includes(day)} onClick={() => setWeekdays(value => value.includes(day) ? value.filter(item => item !== day) : [...value, day])}>{label}</button>)}</div>}<button className="primary wide" disabled={!title.trim() || (recurrence === 'weekdays-custom' && !weekdays.length)} onClick={() => onSave({ id: routine?.id || crypto.randomUUID(), title: title.trim(), section, recurrence: { type: recurrence, weekdays: recurrence === 'weekdays-custom' ? weekdays : undefined }, active: routine?.active ?? true, goalId: routine?.goalId, createdAt: routine?.createdAt || now() })}>Save routine</button></div> }

function CaptureMenu({ canNumber, canMilestone, onNumber, onMedia, onMilestone, onNote }: { canNumber: boolean; canMilestone: boolean; onNumber: () => void; onMedia: () => void; onMilestone: () => void; onNote: () => void }) { return <div className="sheet capture-sheet"><span className="label">ADD PROGRESS</span><h2>What happened?</h2><p>Capture it once, then link it wherever it belongs.</p>{canNumber && <button onClick={onNumber}><TrendingUp/> Measurement <ChevronRight size={17}/></button>}<button onClick={onMedia}><Camera/> Photo or screenshot <ChevronRight size={17}/></button><button disabled={!canMilestone} title={canMilestone ? undefined : 'Add an active goal before recording a milestone.'} onClick={onMilestone}><Check/> Milestone <ChevronRight size={17}/></button><button onClick={onNote}><Sparkles/> Note or win <ChevronRight size={17}/></button></div> }

function GoalLinksField({ goals, value, onChange, disabled = false }: { goals: Goal[]; value: string[]; onChange: (ids: string[]) => void; disabled?: boolean }) {
  const selected = value.flatMap(id => goals.find(goal => goal.id === id) ?? [])
  const available = goals.filter(goal => !value.includes(goal.id))
  return <div className="goal-links-field">
    {selected.length > 0 && <div className="goal-link-chips">{selected.map(goal => <button disabled={disabled} key={goal.id} onClick={() => onChange(value.filter(id => id !== goal.id))} type="button">{goal.title}<X size={12}/></button>)}</div>}
    {available.length > 0 && <GoalPicker goals={available} value={undefined} onChange={id => id && onChange([...value, id])} label="Supports goals (optional)" placeholder="Add related goal" allowClear={false} disabled={disabled}/>}
  </div>
}

function NumberForm({ data, initialGoalIds = [], initialHistoryId, onSave }: { data: AppData; initialGoalIds?: string[]; initialHistoryId?: string; onSave: (historyId: string, goalId: string, goalIds: string[], value: number, note: string | undefined, recordedOn: string, file?: File) => Promise<void> }) {
  const histories = data.measurementHistories.filter(history => !history.mergedIntoId && data.goals.some(goal => goal.status === 'active' && goal.measurementHistoryId === history.id))
  const fromGoal = data.goals.find(goal => initialGoalIds.includes(goal.id) && goal.measurementHistoryId)?.measurementHistoryId
  const [historyId, setHistoryId] = useState(histories.some(history => history.id === initialHistoryId) ? initialHistoryId! : histories.some(history => history.id === fromGoal) ? fromGoal! : histories[0]?.id ?? '')
  const linkedForHistory = data.goals.filter(goal => goal.status === 'active' && goal.measurementHistoryId === historyId).map(goal => goal.id)
  const [extraGoalIds, setExtraGoalIds] = useState(initialGoalIds.filter(id => !linkedForHistory.includes(id)))
  const [value, setValue] = useState('')
  const [note, setNote] = useState('')
  const [recordedOn, setRecordedOn] = useState(todayLocal())
  const [file, setFile] = useState<File>()
  const [saving, setSaving] = useState(false)
  const latestAllowedDate = todayLocal()
  const selectedHistory = histories.find(history => history.id === historyId)
  const primaryGoal = data.goals.find(goal => goal.measurementHistoryId === historyId)
  if (!histories.length) return <div className="sheet form-sheet"><span className="label">MEASUREMENT</span><h2>No measurements are configured.</h2><p>Add a numeric goal first, then record one shared observation here.</p></div>
  const save = async () => {
    if (!primaryGoal || value.trim() === '' || !Number.isFinite(Number(value)) || !recordedOn || recordedOn > latestAllowedDate || saving) return
    setSaving(true)
    try { await onSave(historyId, primaryGoal.id, [...new Set([...linkedForHistory, ...extraGoalIds])], Number(value), note.trim() || undefined, recordedOn, file) } finally { setSaving(false) }
  }
  return <div className="sheet form-sheet"><span className="label">MEASUREMENT</span><h2>Record where you are.</h2>
    <label>Measurement<select aria-label="Measurement history" disabled={saving} value={historyId} onChange={event => { setHistoryId(event.target.value); setExtraGoalIds([]) }}>{histories.map(history => <option value={history.id} key={history.id}>{history.label}</option>)}</select></label>
    <small className="shared-note">One {selectedHistory?.label ?? 'measurement'} update supports {linkedForHistory.length} linked goal{linkedForHistory.length === 1 ? '' : 's'} without copies.</small>
    <label>Value<input autoFocus aria-label="Current value" inputMode="decimal" disabled={saving} value={value} onChange={event => setValue(event.target.value)} placeholder={selectedHistory?.unit ? `Value in ${selectedHistory.unit}` : 'Current value'}/></label>
    <label>Date<input type="date" max={latestAllowedDate} disabled={saving} value={recordedOn} onChange={event => setRecordedOn(event.target.value)}/></label>
    <label>Note (optional)<textarea rows={2} disabled={saving} value={note} onChange={event => setNote(event.target.value)} placeholder="What changed?"/></label>
    <label className="file-picker"><Image size={18}/>{file ? file.name : 'Optional photo or screenshot'}<input type="file" accept="image/*" disabled={saving} onChange={event => setFile(event.target.files?.[0])}/></label>
    <GoalLinksField goals={data.goals} value={extraGoalIds} onChange={setExtraGoalIds} disabled={saving}/>
    <button className="primary wide" disabled={!primaryGoal || !recordedOn || recordedOn > latestAllowedDate || value.trim() === '' || !Number.isFinite(Number(value)) || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save measurement'}</button>
  </div>
}

function MilestoneForm({ goals, initialGoalIds = [], onSave }: { goals: Goal[]; initialGoalIds?: string[]; onSave: (goalId: string, goalIds: string[], title: string, recordedOn: string, milestoneId?: string, file?: File) => Promise<void> }) {
  const activeGoals = goals.filter(goal => goal.status === 'active')
  const [goalId, setGoalId] = useState(activeGoals.some(goal => initialGoalIds.includes(goal.id)) ? initialGoalIds.find(id => activeGoals.some(goal => goal.id === id))! : activeGoals[0]?.id || '')
  const [goalIds, setGoalIds] = useState(initialGoalIds)
  const [milestoneId, setMilestoneId] = useState('')
  const [title, setTitle] = useState('')
  const [recordedOn, setRecordedOn] = useState(todayLocal())
  const [file, setFile] = useState<File>()
  const [saving, setSaving] = useState(false)
  const latestAllowedDate = todayLocal()
  const selectedGoal = activeGoals.find(goal => goal.id === goalId)
  const openMilestones = selectedGoal?.milestones.filter(item => !item.done) || []
  const selectedMilestone = openMilestones.find(item => item.id === milestoneId)
  const capturedTitle = selectedMilestone?.title || title.trim()
  if (!activeGoals.length) return <div className="sheet form-sheet"><span className="label">MILESTONE</span><h2>No active goals.</h2><p>Add or reopen a goal before recording a milestone.</p></div>
  const save = async () => {
    if (!goalId || !capturedTitle || !recordedOn || recordedOn > latestAllowedDate || saving) return
    setSaving(true)
    try { await onSave(goalId, [...new Set([goalId, ...goalIds])], capturedTitle, recordedOn, selectedMilestone?.id, file) } finally { setSaving(false) }
  }
  return <div className="sheet form-sheet"><span className="label">MILESTONE</span><h2>What milestone did you reach?</h2><GoalPicker goals={goals} value={goalId} onChange={id => { setGoalId(id ?? ''); setGoalIds(ids => id ? [...new Set([id, ...ids])] : ids); setMilestoneId('') }} allowClear={false} required/>{openMilestones.length > 0 && <label>Planned milestone<select aria-label="Planned milestone" value={milestoneId} onChange={event => { setMilestoneId(event.target.value); if (event.target.value) setTitle('') }}><option value="">Another milestone</option>{openMilestones.map(item => <option value={item.id} key={item.id}>{item.title}</option>)}</select></label>}{!selectedMilestone && <textarea autoFocus aria-label="Milestone reached" rows={2} value={title} onChange={event => setTitle(event.target.value)} placeholder="e.g. Production validation finished"/>}<label>Date<input type="date" max={latestAllowedDate} value={recordedOn} onChange={event => setRecordedOn(event.target.value)}/></label><label className="file-picker"><Camera size={18}/>{file ? file.name : 'Optional photo or screenshot'}<input type="file" accept="image/*" disabled={saving} onChange={event => setFile(event.target.files?.[0])}/></label><GoalLinksField goals={goals.filter(goal => goal.id !== goalId)} value={goalIds.filter(id => id !== goalId)} onChange={ids => setGoalIds([goalId, ...ids])} disabled={saving}/><button className="primary wide" disabled={!goalId || !capturedTitle || !recordedOn || recordedOn > latestAllowedDate || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save milestone'}</button></div>
}
function MediaForm({ goals, initialGoalIds = [], initialKind, initialRecordedOn, onSave }: { goals: Goal[]; initialGoalIds?: string[]; initialKind?: EvidenceKind; initialRecordedOn?: string; onSave: (kind: 'photo' | 'screenshot', goalIds: string[], note: string | undefined, recordedOn: string, file: File) => Promise<void> }) {
  const [kind, setKind] = useState<EvidenceKind>(initialKind === 'screenshot' ? 'screenshot' : 'photo')
  const [goalIds, setGoalIds] = useState(initialGoalIds)
  const [note, setNote] = useState('')
  const [recordedOn, setRecordedOn] = useState(initialRecordedOn ?? todayLocal())
  const [file, setFile] = useState<File>()
  const [saving, setSaving] = useState(false)
  const latestAllowedDate = todayLocal()
  const save = async () => {
    if (!file || !recordedOn || recordedOn > latestAllowedDate || saving) return
    setSaving(true)
    try { await onSave(kind as 'photo' | 'screenshot', goalIds, note.trim() || undefined, recordedOn, file) } finally { setSaving(false) }
  }
  return <div className="sheet form-sheet"><span className="label">PHOTO / SCREENSHOT</span><h2>Keep the receipt.</h2><div className="choice-row"><button className={kind === 'photo' ? 'selected' : ''} aria-pressed={kind === 'photo'} onClick={() => setKind('photo')}>Photo</button><button className={kind === 'screenshot' ? 'selected' : ''} aria-pressed={kind === 'screenshot'} onClick={() => setKind('screenshot')}>Screenshot</button></div><label className="file-picker"><Image size={18}/>{file ? file.name : 'Camera or Photos'}<input type="file" accept="image/*" disabled={saving} onChange={event => setFile(event.target.files?.[0])}/></label><label>Date<input type="date" max={latestAllowedDate} disabled={saving} value={recordedOn} onChange={event => setRecordedOn(event.target.value)}/></label><label>Note (optional)<textarea rows={2} value={note} disabled={saving} onChange={event => setNote(event.target.value)} placeholder="What does this show?"/></label><GoalLinksField goals={goals} value={goalIds} onChange={setGoalIds} disabled={saving}/><button className="primary wide" disabled={!file || !recordedOn || recordedOn > latestAllowedDate || saving} onClick={() => void save()}>{saving ? 'Compressing and saving…' : 'Save privately'}</button></div>
}
function WinForm({ goals, initialGoalIds = [], onSave }: { goals: Goal[]; initialGoalIds?: string[]; onSave: (mode: 'note' | 'win', value: { title: string; note?: string; goalIds: string[]; recordedOn: string }, file?: File) => Promise<void> }) {
  const [mode, setMode] = useState<'note' | 'win'>('note')
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [goalIds, setGoalIds] = useState(initialGoalIds)
  const [recordedOn, setRecordedOn] = useState(todayLocal())
  const [file, setFile] = useState<File>()
  const [saving, setSaving] = useState(false)
  const latestAllowedDate = todayLocal()
  const save = async () => {
    if (!title.trim() || !recordedOn || recordedOn > latestAllowedDate || saving) return
    setSaving(true)
    try { await onSave(mode, { title: title.trim(), note: note.trim() || undefined, goalIds, recordedOn }, file) } finally { setSaving(false) }
  }
  return <div className="sheet form-sheet"><span className="label">NOTE / WIN</span><h2>What happened?</h2><div className="choice-row"><button className={mode === 'note' ? 'selected' : ''} aria-pressed={mode === 'note'} onClick={() => setMode('note')}>Progress note</button><button className={mode === 'win' ? 'selected' : ''} aria-pressed={mode === 'win'} onClick={() => setMode('win')}>Win</button></div><textarea autoFocus aria-label={`${mode === 'win' ? 'Win' : 'Progress note'} title`} rows={2} value={title} disabled={saving} onChange={event => setTitle(event.target.value)} placeholder={mode === 'win' ? 'e.g. First online sale' : 'e.g. Useful customer conversation'}/><textarea aria-label="Optional detail" rows={3} value={note} disabled={saving} onChange={event => setNote(event.target.value)} placeholder="Optional detail"/><label>Date<input type="date" max={latestAllowedDate} disabled={saving} value={recordedOn} onChange={event => setRecordedOn(event.target.value)}/></label><GoalLinksField goals={goals} value={goalIds} onChange={setGoalIds} disabled={saving}/><label className="file-picker"><Camera size={18}/>{file ? file.name : 'Optional photo or screenshot'}<input type="file" accept="image/*" disabled={saving} onChange={event => setFile(event.target.files?.[0])}/></label><button className="primary wide" disabled={!title.trim() || !recordedOn || recordedOn > latestAllowedDate || saving} onClick={() => void save()}>{saving ? 'Saving…' : `Save ${mode}`}</button></div>
}

function GoalDetail({ goal, data, onChange, onUpdateSchedule, onPause, onComplete, onReopen, onToggleMilestone, onReview, onAi, onCapture }: { goal: Goal; data: AppData; onChange: (goal: Goal) => void; onUpdateSchedule: (goalId: string, scheduleId: string, change: { active?: boolean; cadence?: EvidenceSchedule['cadence']; remove?: boolean }) => void; onPause: () => void; onComplete: () => void; onReopen: () => void; onToggleMilestone: (id: string, done: boolean) => void; onReview: () => void; onAi: () => void; onCapture: () => void }) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(goal.title)
  const [next, setNext] = useState(goal.nextAction || '')
  const [milestoneTitle, setMilestoneTitle] = useState('')
  const [addingSchedule, setAddingSchedule] = useState(false)
  const [scheduleKind, setScheduleKind] = useState<EvidenceKind>(goal.kind === 'numeric' ? 'number' : 'note')
  const [scheduleCadence, setScheduleCadence] = useState<EvidenceSchedule['cadence']>('weekly')
  const allGoals = data.goals
  const progress = data.progress
  const evidenceGroups = evidenceCaptureGroups(data).filter(group =>
    group.goalIds.includes(goal.id)
    || Boolean(goal.measurementHistoryId && group.items.some(item => item.historyId === goal.measurementHistoryId)))
  const relevantEvidence = evidenceGroups.flatMap(group => group.items)
  const evidence = evidenceGroups.map(group => ({
    ...group.representative,
    goalIds: group.goalIds,
    mediaId: group.representative.mediaId ?? group.items.map(item => item.mediaId).find(Boolean),
    recordedOn: recordedDateOf(group.canonical),
  }))
  const wins = [...new Map(data.wins.filter(item => evidenceGoalIds(item).includes(goal.id)).map(item => [item.mediaId ? `media:${item.mediaId}` : `win:${item.id}`, item])).values()]
  const linkedGoals = goal.links.flatMap(id => allGoals.find(item => item.id === id) || [])
  const terminal = goal.status === 'completed' || goal.status === 'closed'
  const ownTrackIds = new Set(goal.evidenceSchedules.map(schedule => evidenceTrackKey({ goal, schedule })))
  const scheduleTrackMap = new Map<string, Array<{ goal: Goal; schedule: EvidenceSchedule }>>()
  for (const candidate of data.goals) {
    for (const schedule of candidate.evidenceSchedules) {
      const key = evidenceTrackKey({ goal: candidate, schedule })
      if (candidate.id !== goal.id && !ownTrackIds.has(key)) continue
      scheduleTrackMap.set(key, [...(scheduleTrackMap.get(key) ?? []), { goal: candidate, schedule }])
    }
  }
  const scheduleTracks = [...scheduleTrackMap.entries()].map(([key, members]) => {
    const representative = members.find(item => item.goal.id === goal.id) ?? members[0]
    return { key, ...representative, goalCount: new Set(members.map(item => item.goal.id)).size }
  })
  const matchingTrack = scheduleTracks.find(item => item.schedule.kind === scheduleKind && item.schedule.cadence === scheduleCadence)
  const saveSchedule = () => {
    if (matchingTrack?.schedule.active) return
    if (matchingTrack) onUpdateSchedule(matchingTrack.goal.id, matchingTrack.schedule.id, { active: true })
    else onChange({ ...goal, evidenceSchedules: [...goal.evidenceSchedules, { id: crypto.randomUUID(), kind: scheduleKind, cadence: scheduleCadence, historyId: goal.measurementHistoryId, firstDueDate: todayLocal(), active: true, provenance: 'manual' }] })
    setAddingSchedule(false)
  }
  const measurements = progress.filter(entry => goal.measurementHistoryId ? entry.historyId === goal.measurementHistoryId : entry.goalId === goal.id)
  const measurementIds = new Set(measurements.map(item => item.id))
  const companions = new Map(measurements.map(item => [item.id, evidence.filter(value => value.observationId === item.id)]))
  const capturedMilestoneIds = new Set(relevantEvidence.flatMap(item => item.milestoneId ? [item.milestoneId] : []))
  const capturedMilestoneTitles = new Set(relevantEvidence
    .filter(item => item.kind === 'milestone')
    .flatMap(item => item.note?.trim() ? [item.note.trim().toLowerCase()] : []))
  const lifecycleMilestones = goal.history.flatMap((event, index) => {
    if ((event.action !== 'milestone' && event.action !== 'completed') || !event.note?.startsWith('Completed milestone: ')) return []
    const title = event.note.slice('Completed milestone: '.length).trim()
    const planned = goal.milestones.find(item => item.title === title)
    if ((planned && capturedMilestoneIds.has(planned.id)) || capturedMilestoneTitles.has(title.toLowerCase())) return []
    return [{ id: `lifecycle-${index}`, type: 'milestone' as const, date: localDateOf(event.at), note: title, mediaId: undefined, value: undefined, unit: undefined }]
  })
  const activity = [
    ...measurements.map(item => {
      const related = companions.get(item.id) ?? []
      return { id: item.id, type: 'measurement' as const, date: recordedDateOf(item), value: item.value, unit: goal.unit, note: item.note || related.map(value => value.note).find(Boolean), mediaId: related.map(value => value.mediaId).find(Boolean) }
    }),
    ...evidence.filter(item => !item.observationId || !measurementIds.has(item.observationId)).map(item => {
      const observation = item.observationId ? progress.find(value => value.id === item.observationId) : undefined
      const plannedMilestone = item.milestoneId ? goal.milestones.find(value => value.id === item.milestoneId) : undefined
      return { id: item.id, type: plannedMilestone ? 'milestone' as const : item.kind, date: recordedDateOf(item), note: plannedMilestone?.title ?? item.note, mediaId: item.mediaId, value: item.value ?? observation?.value, unit: observation ? allGoals.find(value => value.id === observation.goalId)?.unit : undefined }
    }),
    ...lifecycleMilestones,
    ...wins.map(item => ({ id: item.id, type: 'win' as const, date: recordedDateOf(item), note: [item.title, item.note].filter(Boolean).join(' — '), mediaId: item.mediaId, value: undefined, unit: undefined })),
  ].sort((left, right) => right.date.localeCompare(left.date) || right.id.localeCompare(left.id))
  const scheduleLabel = (schedule: EvidenceSchedule) => {
    const subject = schedule.kind === 'number' && goal.unit?.toLowerCase() === 'lbs' ? 'Log weight'
      : schedule.kind === 'number' ? `Update ${goal.title}`
        : schedule.kind === 'photo' && goal.area === 'Body' ? 'Take a progress photo'
          : schedule.kind === 'note' && goal.area === 'Business' ? 'Add a business update'
            : schedule.kind === 'note' ? 'Add a progress note'
              : schedule.kind === 'screenshot' ? 'Add a screenshot' : 'Record a milestone'
    return subject
  }
  const scheduleNext = (owner: Goal, schedule: EvidenceSchedule) => nextEvidenceDueForSchedule(data, owner.id, schedule.id) ?? schedule.firstDueDate ?? todayLocal()
  return <div className="sheet detail-sheet">
    <span className="label">{goal.horizon} · {goal.status.toUpperCase()}</span>
    <h2>{goal.title}</h2>
    <GoalProgress goal={goal}/>
    <div className="detail-section"><span>DEADLINE</span><b>{formatDate(goal.deadline)}</b></div>
    <div className="detail-section goal-next"><span>NEXT MEANINGFUL ACTION</span><b>{goal.nextAction || (terminal ? 'No next action — this goal is historical.' : 'Choose the next meaningful action')}</b></div>
    {goal.milestones.length > 0 && <div className="detail-section milestone-list"><span>PATH</span>{goal.milestones.map(item => <button key={item.id} aria-pressed={item.done} disabled={terminal} onClick={() => onToggleMilestone(item.id, !item.done)}>{item.done ? <Check size={15}/> : <Circle size={15}/>} {item.title}</button>)}</div>}
    {linkedGoals.length > 0 && <div className="detail-section"><span>WHERE THIS LEADS</span>{linkedGoals.map(link => <b key={link.id}>→ {link.title}</b>)}</div>}
    <div className="detail-section actual-progress"><span>YOUR PROGRESS</span>
      {activity.length ? activity.slice(0, 5).map(item => <div className="goal-activity" key={`${item.type}:${item.id}`}>{item.mediaId ? <MediaView mediaId={item.mediaId} defer alt={`${item.type} progress`}/> : item.type === 'measurement' || item.type === 'number' ? <TrendingUp size={17}/> : item.type === 'milestone' ? <Check size={17}/> : item.type === 'win' ? <Sparkles size={17}/> : <Camera size={17}/>}<span><b>{(item.type === 'measurement' || item.type === 'number') && item.value !== undefined ? formatValue(item.value, item.unit) : item.note || `${item.type} captured`}</b><small>{formatDate(item.date)}{(item.type === 'measurement' || item.type === 'number') && item.note ? ` · ${item.note}` : ''}</small></span></div>) : <small>No progress captured yet.</small>}
      {goal.status === 'active' && <button className="primary wide goal-capture" onClick={onCapture}><Plus size={16}/> Add progress</button>}
    </div>
    <div className="detail-section schedule-list"><span>CAPTURE REMINDERS</span>
      {scheduleTracks.length === 0 && !addingSchedule && <small>No reminders. Add a quiet check-in when it would help.</small>}
      {scheduleTracks.map(item => <div className="schedule-track" key={item.key}>
        <span><b>{scheduleLabel(item.schedule)}</b><small>{item.schedule.active ? `Next due ${formatDate(scheduleNext(item.goal, item.schedule))}` : 'Paused'}{item.goalCount > 1 ? ` · shared across ${item.goalCount} goals` : ''}</small></span>
        <div className="schedule-controls">
          <select aria-label={`Cadence for ${scheduleLabel(item.schedule)}`} value={item.schedule.cadence} disabled={terminal} onChange={event => onUpdateSchedule(item.goal.id, item.schedule.id, { cadence: event.target.value as EvidenceSchedule['cadence'] })}><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option></select>
          <button aria-pressed={item.schedule.active} disabled={terminal} onClick={() => onUpdateSchedule(item.goal.id, item.schedule.id, { active: !item.schedule.active })}>{item.schedule.active ? 'Pause' : 'Resume'}</button>
          <button disabled={terminal} onClick={() => window.confirm(`Remove “${scheduleLabel(item.schedule)}”${item.goalCount > 1 ? ` from all ${item.goalCount} linked goals` : ''}? Captured progress stays intact.`) && onUpdateSchedule(item.goal.id, item.schedule.id, { remove: true })}>Remove</button>
        </div>
      </div>)}
      {goal.status === 'active' && !addingSchedule && <button className="schedule-add" onClick={() => setAddingSchedule(true)}><Plus size={14}/> Add reminder</button>}
      {goal.status === 'active' && addingSchedule && <div className="schedule-creator"><label>Capture<select aria-label="Evidence reminder kind" value={scheduleKind} onChange={event => setScheduleKind(event.target.value as EvidenceKind)}>{goal.kind === 'numeric' && <option value="number">Measurement</option>}<option value="photo">Photo</option><option value="screenshot">Screenshot</option><option value="note">Progress note</option><option value="milestone">Milestone</option></select></label><label>Cadence<select aria-label="Evidence reminder cadence" value={scheduleCadence} onChange={event => setScheduleCadence(event.target.value as EvidenceSchedule['cadence'])}><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option></select></label><div><button onClick={() => setAddingSchedule(false)}>Cancel</button><button disabled={Boolean(matchingTrack?.schedule.active)} onClick={saveSchedule}>{matchingTrack?.schedule.active ? 'Already active' : matchingTrack ? 'Resume reminder' : 'Add reminder'}</button></div></div>}
    </div>
    <div className="goal-actions">
      {goal.status === 'active' && <button onClick={onAi}><Sparkles size={15}/> Help me plan</button>}
      {!terminal && <button aria-pressed={editing} onClick={() => setEditing(!editing)}><Pencil size={15}/> Edit</button>}
      {!terminal && <button aria-pressed={goal.status === 'paused'} onClick={onPause}>{goal.status === 'paused' ? <RotateCcw size={15}/> : <Pause size={15}/>} {goal.status === 'paused' ? 'Resume' : 'Pause'}</button>}
      {!terminal && <button onClick={() => window.confirm(`Mark “${goal.title}” complete?`) && onComplete()}><Check size={15}/> Complete</button>}
      {goal.status === 'completed' && <button onClick={onReopen}><RotateCcw size={15}/> Reopen for correction</button>}
    </div>
    {editing && !terminal && <div className="inline-editor"><label>Goal<input value={title} onChange={event => setTitle(event.target.value)}/></label><label>Next action<textarea rows={2} value={next} onChange={event => setNext(event.target.value)} placeholder="Next action"/></label><label>New milestone<textarea rows={2} value={milestoneTitle} onChange={event => setMilestoneTitle(event.target.value)} placeholder="Optional path step"/></label><button className="secondary" disabled={!milestoneTitle.trim()} onClick={() => { onChange({ ...goal, milestones: [...goal.milestones, { id: crypto.randomUUID(), title: milestoneTitle.trim(), done: false }] }); setMilestoneTitle('') }}>Add milestone</button><GoalLinksField goals={allGoals.filter(item => item.id !== goal.id)} value={goal.links} onChange={links => onChange({ ...goal, links })}/><button className="primary" disabled={!title.trim()} onClick={() => { onChange({ ...goal, title: title.trim(), nextAction: next.trim() || undefined }); setEditing(false) }}>Save</button></div>}
    {!terminal && <button className="deadline-link" onClick={onReview}>Review / close this goal <ChevronRight size={15}/></button>}
    <small className="evidence-count">{activity.length} captured progress item{activity.length === 1 ? '' : 's'} · {goal.history.length} lifecycle event{goal.history.length === 1 ? '' : 's'}</small>
  </div>
}
function DeadlineAlignment({ data, onUseCalendar, onKeepCurrent }: { data: AppData; onUseCalendar: (goals: Goal[]) => void; onKeepCurrent: (goals: Goal[]) => void }) {
  const previews = deadlineCorrectionPreview(data)
  const uncertain = previews.flatMap(preview => data.goals.find(goal => goal.id === preview.goalId) ?? [])
  const aligned = uncertain.map((goal, index) => {
    const deadline = previews[index].to
    return { ...goal, deadline, deadlineAnchor: goal.deadlineAnchor ?? planningAnchorFor(goal.createdAt), deadlineProvenance: 'calendar-default' as const, history: [...goal.history, { at: now(), action: 'adjusted' as const, note: `Calendar alignment confirmed; previous deadline ${goal.deadline}`, current: goal.current, target: goal.target, deadline }] }
  })
  return <div className="sheet deadline-alignment"><span className="label">ONE-TIME CONFIRMATION</span><h2>Align planning to month starts?</h2><p>These dates came from an older version, so Momentum will not guess. Manual dates and completed goals are untouched.</p><div className="deadline-preview-list">{uncertain.map((goal, index) => <div key={goal.id}><span><b>{goal.title}</b><small>{goal.horizon}</small></span><span><s>{formatDate(goal.deadline)}</s><ChevronRight size={13}/><b>{formatDate(aligned[index].deadline)}</b></span></div>)}</div>{uncertain.length ? <><button className="primary wide" onClick={() => onUseCalendar(aligned)}><CalendarDays size={16}/> Use calendar dates</button><button className="secondary wide" onClick={() => onKeepCurrent(uncertain)}>Keep current dates</button></> : <p>Every existing deadline has already been classified.</p>}</div>
}
function DeadlineReview({ goal, onBack, onSave }: { goal: Goal; onBack: () => void; onSave: (action: 'continue' | 'adjust' | 'close', reason: DeadlineReason, options?: { deadline?: string; target?: number; note?: string }) => void }) {
  const [reason, setReason] = useState<DeadlineReason>()
  const [action, setAction] = useState<'continue' | 'adjust' | 'close'>()
  const [deadline, setDeadline] = useState(deadlineFor(goal.horizon))
  const [target, setTarget] = useState(goal.target?.toString() || '')
  const [note, setNote] = useState('')
  const minimumDeadline = addDays(todayLocal(), 1)
  const targetValid = action !== 'adjust' || goal.kind !== 'numeric' || (target.trim() !== '' && Number.isFinite(Number(target)))
  const deadlineValid = action === 'close' || (isRealLocalDate(deadline) && deadline >= minimumDeadline)
  return <div className="sheet form-sheet"><button className="back" onClick={onBack}><ChevronLeft size={16}/> Goal</button><span className="label">DEADLINE REVIEW</span><h2>{goal.title}</h2><div className="result-row"><span>Target<b>{goal.target === undefined ? 'Not numeric' : formatValue(goal.target, goal.unit)}</b></span><span>Actual<b>{goal.current === undefined ? 'Not recorded' : formatValue(goal.current, goal.unit)}</b></span></div><p>What happened?</p><div className="reason-grid">{reasons.map(([value, label]) => <button aria-pressed={reason === value} className={reason === value ? 'selected' : ''} key={value} onClick={() => setReason(value)}>{label}</button>)}</div>{reason && <><div className="action-grid"><button aria-pressed={action === 'continue'} className={action === 'continue' ? 'selected' : ''} onClick={() => setAction('continue')}><b>Continue</b><small>Same goal, new deadline</small></button><button aria-pressed={action === 'adjust'} className={action === 'adjust' ? 'selected' : ''} onClick={() => setAction('adjust')}><b>Adjust</b><small>Change target or plan</small></button><button aria-pressed={action === 'close'} className={action === 'close' ? 'selected' : ''} onClick={() => setAction('close')}><b>Close</b><small>Accept and archive</small></button></div>{action && action !== 'close' && <label>New deadline<input type="date" min={minimumDeadline} value={deadline} onChange={event => setDeadline(event.target.value)}/>{!deadlineValid && <small>Choose a real date after today.</small>}</label>}{action === 'adjust' && goal.kind === 'numeric' && <label>New target<input inputMode="decimal" value={target} onChange={event => setTarget(event.target.value)}/></label>}<input aria-label="Optional review note" value={note} onChange={event => setNote(event.target.value)} placeholder="Optional note"/></>}<button className="primary wide" disabled={!reason || !action || !targetValid || !deadlineValid} onClick={() => reason && action && onSave(action, reason, { deadline: action === 'close' ? undefined : deadline, target: action === 'adjust' && goal.kind === 'numeric' ? Number(target) : undefined, note: note.trim() || undefined })}>Save review</button></div>
}

function EvidenceGallery({ evidence, goals, selected, onSelect, onDelete }: { evidence: Evidence[]; goals: Goal[]; selected?: Evidence; onSelect: (id?: string) => void; onDelete: (group: ReturnType<typeof evidenceCaptureGroups>[number]) => void }) {
  const groups = evidenceCaptureGroups({ evidence })
  const selectedGroup = selected ? groups.find(group => group.items.some(item => item.id === selected.id)) : undefined
  const linkedGoals = (group: ReturnType<typeof evidenceCaptureGroups>[number]) => {
    const historyIds = new Set(group.items.flatMap(item => item.historyId ? [item.historyId] : []))
    const ids = new Set([...group.goalIds, ...goals.filter(goal => goal.measurementHistoryId && historyIds.has(goal.measurementHistoryId)).map(goal => goal.id)])
    return [...ids].flatMap(id => goals.find(goal => goal.id === id) ?? [])
  }
  const groupNote = (group: ReturnType<typeof evidenceCaptureGroups>[number]) => [group.representative, ...group.items]
    .map(item => item.note?.trim())
    .find(Boolean)
  const evidenceVisual = (group: ReturnType<typeof evidenceCaptureGroups>[number], full = false) => {
    const item = group.representative
    const mediaId = group.canonical.mediaId ?? group.items.map(value => value.mediaId).find(Boolean)
    if (mediaId) return <MediaView mediaId={mediaId} full={full} defer={!full} alt={`${item.kind} evidence${linkedGoals(group).length ? ` for ${linkedGoals(group).map(goal => goal.title).join(', ')}` : ''}`}/>
    if (item.kind === 'number' && item.value !== undefined) return <div className={full ? 'number-evidence full' : 'number-evidence'}><TrendingUp size={18}/><b>{formatValue(item.value, linkedGoals(group)[0]?.unit)}</b></div>
    if (item.kind === 'milestone' || item.kind === 'note') return <div className={full ? 'number-evidence full' : 'number-evidence'}>{item.kind === 'milestone' ? <Check size={18}/> : <Pencil size={18}/>}<b>{groupNote(group) || `${item.kind} captured`}</b></div>
    return <MediaView full={full} defer={!full} alt={`${item.kind} evidence`}/>
  }
  if (selectedGroup) { const item = selectedGroup.representative; const related = linkedGoals(selectedGroup); const note = groupNote(selectedGroup); return <div className="sheet evidence-full"><button className="back" onClick={() => onSelect(undefined)}><ChevronLeft size={16}/> Evidence</button>{evidenceVisual(selectedGroup, true)}<span className="label">{item.kind.toUpperCase()} CAPTURE</span><h2>{related.map(goal => goal.title).join(' · ') || 'Unlinked evidence'}</h2><p>{formatDate(recordedDateOf(selectedGroup.canonical))}{note ? ` · ${note}` : ''}{related.length > 1 ? ` · Linked to ${related.length} goals` : ''}</p><button className="danger-button" onClick={() => onDelete(selectedGroup)}><Trash2 size={15}/> Delete capture</button></div> }
  return <div className="sheet"><span className="label">PRIVATE ON THIS DEVICE</span><h2>Evidence</h2>{groups.length ? <div className="evidence-grid">{groups.slice().sort((left, right) => recordedDateOf(right.canonical).localeCompare(recordedDateOf(left.canonical))).map(group => { const related = linkedGoals(group); return <button key={group.key} onClick={() => onSelect(group.representative.id)}>{evidenceVisual(group)}<span>{group.representative.kind}{related.length > 1 ? ` · ${related.length} goals` : ''}</span><small>{formatDate(recordedDateOf(group.canonical))}</small></button> })}</div> : <p>No evidence yet. Add a photo, screenshot, note, or milestone from Progress or any goal.</p>}</div>
}
function MediaView({ mediaId, full = false, defer = false, alt = 'Progress evidence' }: { mediaId?: string; full?: boolean; defer?: boolean; alt?: string }) {
  const [url, setUrl] = useState<string>()
  const [shouldLoad, setShouldLoad] = useState(!defer)
  const [unavailable, setUnavailable] = useState(false)
  const placeholderRef = useRef<HTMLDivElement>(null)
  useEffect(() => { setShouldLoad(!defer); setUnavailable(false) }, [defer, mediaId])
  useEffect(() => {
    if (!defer || shouldLoad || !mediaId) return
    const target = placeholderRef.current
    if (!target || typeof IntersectionObserver === 'undefined') { setShouldLoad(true); return }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setShouldLoad(true)
        observer.disconnect()
      }
    }, { rootMargin: '240px 0px' })
    observer.observe(target)
    return () => observer.disconnect()
  }, [defer, mediaId, shouldLoad])
  useEffect(() => {
    setUrl(undefined)
    setUnavailable(false)
    if (!mediaId || !shouldLoad) return
    let live = true
    let objectUrl: string | undefined
    getMedia(mediaId).then(record => {
      if (!live) return
      if (!record) { setUnavailable(true); return }
      objectUrl = URL.createObjectURL(record.blob)
      setUrl(objectUrl)
    }).catch(() => { if (live) setUnavailable(true) })
    return () => { live = false; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [mediaId, shouldLoad])
  if (url) return <img className={full ? 'media-full' : 'media-thumb'} src={url} alt={alt} loading={defer ? 'lazy' : 'eager'}/>
  const label = !mediaId ? 'No evidence image' : unavailable ? 'Evidence image unavailable' : shouldLoad ? 'Loading evidence image' : 'Evidence image loads when visible'
  return <div ref={placeholderRef} className={full ? 'media-full empty' : 'media-thumb empty'} aria-label={label} aria-busy={Boolean(mediaId && shouldLoad && !unavailable)}><Camera size={20}/></div>
}

function SettingsPanel({ data, mediaSize, onRoutines, onSettings, onExport, onImport, onClear }: { data: AppData; mediaSize: number; onRoutines: () => void; onSettings: (settings: AppData['settings']) => void; onExport: (includeMedia: boolean) => Promise<void>; onImport: (file: File) => void; onClear: () => void }) {
  const settings = data.settings
  const ai = applyMonthlyReset(settings.ai)
  const importRef = useRef<HTMLInputElement>(null)
  const [exporting, setExporting] = useState(false)
  const setCap = (raw: string) => { const cap = Number(raw); if (Number.isFinite(cap)) onSettings({ ...settings, ai: { ...ai, monthlyCap: Math.max(0, cap) } }) }
  const exportBackup = async (includeMedia: boolean) => { if (exporting) return; setExporting(true); try { await onExport(includeMedia) } finally { setExporting(false) } }
  return <div className="sheet settings-sheet"><span className="label">PERSONAL SPACE</span><h2>Settings</h2><div className="settings-group"><span>ROUTINES</span><button onClick={onRoutines}>Manage routines <em>{data.routines.filter(item => item.active).length} active</em><ChevronRight size={16}/></button></div><div className="settings-group"><span>AREAS</span><div className="area-chips">{settings.areas.map(area => <span key={area}>{area}</span>)}</div></div><div className="settings-group"><span>AI · OPTIONAL</span><label className="settings-toggle">Enabled <input type="checkbox" checked={ai.enabled} onChange={event => onSettings({ ...settings, ai: { ...ai, enabled: event.target.checked } })}/></label><div className="usage"><span>This month<b>${ai.estimatedCost.toFixed(4)} estimated</b></span><span>Requests<b>{ai.requests}</b></span></div><label>Monthly limit<input aria-label="AI monthly dollar limit" type="number" min="0" step="0.1" value={ai.monthlyCap} onChange={event => setCap(event.target.value)}/></label><small>Model: {AI_MODEL}. Calls happen only when you tap Generate. The in-app cap is local; set a provider project limit as the external backstop.</small></div><div className="settings-group"><span>REMINDERS · IN APP</span>{Object.entries(settings.reminders).filter(([key]) => key !== 'morning').map(([key, value]) => <label className="settings-toggle" key={key}>{key.replaceAll('-', ' ')}<input type="checkbox" checked={value} onChange={event => onSettings({ ...settings, reminders: { ...settings.reminders, [key]: event.target.checked } })}/></label>)}</div><div className="settings-group"><span>DATA</span><button disabled={exporting} onClick={() => void exportBackup(true)}><Download size={16}/> {exporting ? 'Creating backup…' : 'Export Full Backup'} <ChevronRight size={16}/></button><button disabled={exporting} onClick={() => void exportBackup(false)}><Download size={16}/> Export Data Only <ChevronRight size={16}/></button><button disabled={exporting} onClick={() => importRef.current?.click()}><Upload size={16}/> Import Backup <ChevronRight size={16}/></button><input className="hidden-input" ref={importRef} type="file" accept="application/json" onChange={event => { const file = event.target.files?.[0]; if (file) onImport(file); event.target.value = '' }}/></div><div className="storage">Evidence media <b>{(mediaSize / 1024 / 1024).toFixed(1)} MB</b></div><div className="settings-group danger"><span>DANGER</span><button onClick={onClear}><Trash2 size={16}/> Reset all local data</button></div></div>
}

function MomentumDetail({ result }: { result: ReturnType<typeof calculateMomentum> }) { return <div className="sheet"><span className="label">TRAILING 14 DAYS</span><h2>{result.status === 'building' ? 'Building baseline' : <>Momentum <strong>{result.score}</strong></>}</h2><p>{result.status === 'building' ? `Complete commitments across at least 3 eligible days. You have ${result.eligibleDays}.` : `How consistently you did what you said mattered${result.trend ? ` · ${result.trend > 0 ? '+' : ''}${result.trend} vs prior window` : ''}.`}</p><Score label={`Goal Moves · ${result.commitments.moves} commitments`} value={result.weights.moves ? result.moves : undefined}/><Score label={`Routines · ${result.commitments.routines} commitments`} value={result.weights.routines ? result.routines : undefined}/><Score label="Objective progress" value={result.weights.progress ? result.progress : undefined}/><div className="formula">Base weights: Goal Moves 65% · Routines 25% · progress 10%. Missing components are omitted and the active weights are normalized. Days are averaged before components, so adding trivial tasks cannot overpower another day. Intentional light/rest days are excluded.</div></div> }
function Score({ label, value }: { label: string; value?: number }) { return <div className="score-row"><div><span>{label}</span><b>{value === undefined ? '—' : value}</b></div><i><em style={{ width: `${value || 0}%` }}/></i></div> }

function Story({ data, period, onAi, onDone }: { data: AppData; period: PeriodRecord; onAi: () => void; onDone: () => void }) {
  const facts = recapFacts(data, period)
  const [card, setCard] = useState(0)
  const trackRef = useRef<HTMLDivElement>(null)
  const periodStart = [period.effectiveStart ?? period.start, data.planning.trackingStartedOn].sort().at(-1)!
  const inPeriod = (timestamp: string) => { const date = localDateOf(timestamp); return date >= periodStart && date <= period.end }
  const periodWins = data.wins.filter(win => inPeriod(recordedDateOf(win)))
  const periodEvidence = evidenceCaptureGroups(data)
    .flatMap(capture => {
      const mediaId = capture.items.map(item => item.mediaId).find(Boolean)
      return inPeriod(recordedDateOf(capture.canonical)) && mediaId ? [{
        id: capture.key,
        mediaId,
        alt: capture.items.map(item => item.note?.trim()).find(Boolean) || `${capture.representative.kind} evidence`,
      }] : []
    })
  const featuredMedia = [...periodWins.flatMap(win => win.mediaId ? [{ id: win.id, mediaId: win.mediaId, alt: win.title }] : []), ...periodEvidence][0]
  const moved = facts.goalMoves.done > 0 || facts.wins.length > 0 || facts.milestones.length > 0 || facts.completedGoals.length > 0 || facts.numeric.some(item => item.hasComparison && item.change !== 0)
  const cards: React.ReactNode[] = [
    <section className="story-card intro" key="intro"><span>{periodStart > period.start ? 'PARTIAL PERIOD · ' : ''}{periodLabel(period).toUpperCase()}</span><h2>{moved ? 'You moved.' : 'An honest look.'}</h2><p>{formatDate(periodStart)} — {formatDate(period.end)}</p></section>,
    ...(facts.goalMoves.due > 0 || facts.activeDays > 0 ? [<section className="story-card" key="execution"><span>EXECUTION</span><h2>{facts.momentumStatus === 'building' ? 'Building baseline' : `${facts.momentum} Momentum`}</h2><p>{facts.goalMoves.done}/{facts.goalMoves.due} Goal Moves · {facts.activeDays} active days</p></section>] : []),
    ...facts.numeric.map(item => <section className="story-card metric-story" key={item.goalId}><span>{item.title.toUpperCase()}</span>{item.hasComparison ? <><h2>{formatValue(item.start, item.unit)} → {formatValue(item.end, item.unit)}</h2><p>{item.change >= 0 ? '+' : ''}{formatValue(item.change, item.unit)} during this period</p></> : <><h2>{formatValue(item.end, item.unit)}</h2><p>Starting point recorded. A trend begins with the next observation.</p></>}</section>),
    ...(facts.completedGoals.length ? [<section className="story-card" key="completed"><span>COMPLETED</span><h2>{facts.completedGoals.length} goal{facts.completedGoals.length === 1 ? '' : 's'} closed with a result.</h2>{facts.completedGoals.map((title, index) => <h3 key={`${title}:${index}`}>✓ {title}</h3>)}</section>] : []),
    ...(facts.wins.length ? [<section className="story-card wins-story" key="wins"><span>BIGGEST WINS</span>{facts.wins.slice(0, 5).map((win, index) => <h3 key={`${win}:${index}`}>✓ {win}</h3>)}</section>] : []),
    ...(facts.milestones.length ? [<section className="story-card" key="milestones"><span>MILESTONES</span>{facts.milestones.slice(0, 6).map((milestone, index) => <h3 key={`${milestone}:${index}`}>✓ {milestone}</h3>)}</section>] : []),
    ...(featuredMedia ? [<section className="story-card evidence-story" key={`media:${featuredMedia.id}`}><span>RECEIPT</span><MediaView mediaId={featuredMedia.mediaId} full alt={featuredMedia.alt}/><p>{featuredMedia.alt}</p></section>] : []),
    ...(facts.strongest !== '—' || facts.needsAttention !== '—' ? [<section className="story-card" key="focus"><span>FOCUS</span>{facts.strongest !== '—' && <><h3>Most followed through</h3><h2>{facts.strongest}</h2></>}{facts.needsAttention !== '—' && <p>Needs attention next: {facts.needsAttention}</p>}</section>] : []),
    <section className="story-card next" key="next"><span>NEXT</span><h2>Keep the receipts.</h2><p>Your next period is ready to shape.</p><button onClick={onAi}><Sparkles size={15}/> Write a short perspective</button><button onClick={onDone}>Done</button></section>,
  ]
  const goTo = (index: number) => {
    const next = Math.max(0, Math.min(cards.length - 1, index))
    const track = trackRef.current
    const target = track?.children[next] as HTMLElement | undefined
    if (track && target) {
      track.scrollTo({ left: target.offsetLeft - (track.clientWidth - target.offsetWidth) / 2, behavior: 'smooth' })
    }
    setCard(next)
  }
  return <div className="story-sheet"><div className="story-progress" aria-label={`Card ${card + 1} of ${cards.length}`}>{cards.map((_, index) => <button aria-label={`Go to story card ${index + 1}`} aria-current={index === card ? 'step' : undefined} className={index <= card ? 'active' : ''} key={index} onClick={() => goTo(index)}/>)}</div><div className="story-track" ref={trackRef} tabIndex={0} aria-label="Recap story cards" onKeyDown={event => { if (event.key === 'ArrowRight') { event.preventDefault(); goTo(card + 1) } if (event.key === 'ArrowLeft') { event.preventDefault(); goTo(card - 1) } }} onScroll={event => { const element = event.currentTarget; const center = element.scrollLeft + element.clientWidth / 2; const index = [...element.children].reduce((best, child, candidate) => Math.abs((child as HTMLElement).offsetLeft + (child as HTMLElement).offsetWidth / 2 - center) < Math.abs((element.children[best] as HTMLElement).offsetLeft + (element.children[best] as HTMLElement).offsetWidth / 2 - center) ? candidate : best, 0); setCard(index) }}>{cards}</div><div className="story-controls"><button disabled={card === 0} onClick={() => goTo(card - 1)}><ChevronLeft size={16}/> Previous</button><button disabled={card === cards.length - 1} onClick={() => goTo(card + 1)}>Next <ChevronRight size={16}/></button></div></div>
}

function AiPanel({ state, settings, selectedGoal, goals, onRun, onCancel, onAcceptAction, onAcceptTitle, onAcceptMilestone, onAcceptEvidence, onAcceptLink, onClarification, onDismiss }: { state: { loading: boolean; action?: string; result?: AiResult; error?: string }; settings: AppData['settings']['ai']; selectedGoal?: Goal; goals: Goal[]; onRun: () => void; onCancel: () => void; onAcceptAction: (suggestion: AiSuggestion) => boolean; onAcceptTitle: (title: string) => void; onAcceptMilestone: (title: string) => void; onAcceptEvidence: (suggestion: string) => boolean; onAcceptLink: (value: string) => boolean; onClarification: (goalId: string, answer: string) => void; onDismiss: () => void }) {
  const usage = applyMonthlyReset(settings)
  const capped = !canCallAi(usage)
  const heading = state.action === 'today' ? 'Suggest today’s moves' : state.action === 'week' ? 'Get perspective' : state.action === 'recap' ? 'Write recap summary' : `Plan ${selectedGoal?.title || 'this goal'}`
  const privacy = state.action === 'today'
    ? 'Relevant active goals, plans, recent progress, and Today task states are sent. Photos, private media, and the rest of your database stay on this device.'
    : state.action === 'plan'
      ? 'The selected goal, related active goals, relevant tasks, and recent progress are sent. Photos and private media stay on this device.'
      : 'Only computed facts for this period are sent. Photos and private media stay on this device.'
  return <div className="sheet ai-sheet"><span className="label">OPTIONAL AI</span><h2>{heading}</h2><p>{privacy} Every proposed change waits for you.</p>
    {!state.result && !state.error && <><button className="primary wide" disabled={state.loading || !usage.enabled || capped} onClick={onRun}>{state.loading ? 'Thinking…' : !usage.enabled ? 'Enable AI in Settings first' : capped ? 'Monthly AI limit reached' : 'Generate suggestions'}</button>{state.loading && <button className="secondary wide" onClick={onCancel}>Cancel request</button>}</>}
    {state.error && <div className="error-box" role="alert">{state.error}{usage.enabled && !capped && <button onClick={onRun}>Try again</button>}</div>}
    {state.result?.kind === 'today' && <div className="ai-result"><ClarificationCard clarification={state.result.clarification} goals={goals} onSubmit={onClarification}/>{state.result.suggestions.length > 0 && <section><span>SUGGESTED GOAL MOVES</span>{state.result.suggestions.map(item => <SuggestionCard key={item.id} suggestion={item} goals={goals} onAccept={onAcceptAction}/>)}</section>}<button className="secondary wide" onClick={onDismiss}>Done</button></div>}
    {state.result?.kind === 'plan' && <PlanAiResult key={`${state.result.goalId}:${state.result.suggestions.map(item => item.id).join(':')}`} result={state.result} selectedGoal={selectedGoal} goals={goals} onAcceptAction={onAcceptAction} onAcceptTitle={onAcceptTitle} onAcceptMilestone={onAcceptMilestone} onAcceptEvidence={onAcceptEvidence} onAcceptLink={onAcceptLink} onClarification={onClarification} onDismiss={onDismiss}/>}
    {(state.result?.kind === 'week' || state.result?.kind === 'recap') && <PerspectiveResult result={state.result} onDismiss={onDismiss}/>}
    <small>Device estimate this month: ${usage.estimatedCost.toFixed(4)} of ${usage.monthlyCap.toFixed(2)} · {usage.requests} requests. Provider-side limits are separate.</small>
  </div>
}

function SuggestionCard({ suggestion, goals, onAccept }: { suggestion: AiSuggestion; goals: Goal[]; onAccept: (suggestion: AiSuggestion) => boolean }) {
  const validGoal = goals.find(goal => goal.id === suggestion.goalId && goal.status === 'active')
  const [draft, setDraft] = useState({ ...suggestion, goalId: validGoal?.id ?? '' })
  const [editing, setEditing] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [accepted, setAccepted] = useState(false)
  if (dismissed) return null
  const goal = goals.find(item => item.id === draft.goalId)
  const accept = () => {
    if (accepted || !draft.title.trim() || !draft.nextStep.trim() || !goal || goal.status !== 'active') return
    if (onAccept({ ...draft, title: draft.title.trim(), nextStep: draft.nextStep.trim(), reason: draft.reason.trim() })) setAccepted(true)
  }
  return <article className={`suggestion-card${!validGoal ? ' needs-repair' : ''}`}>
    {editing ? <><label>Task title<textarea rows={2} value={draft.title} onChange={event => setDraft(value => ({ ...value, title: event.target.value }))}/></label><label>Done when<textarea rows={3} value={draft.nextStep} onChange={event => setDraft(value => ({ ...value, nextStep: event.target.value }))}/></label><label>Why now<textarea rows={2} value={draft.reason} onChange={event => setDraft(value => ({ ...value, reason: event.target.value }))}/></label><GoalPicker goals={goals} value={draft.goalId || undefined} onChange={id => setDraft(value => ({ ...value, goalId: id ?? '' }))} suggestedGoalId={validGoal?.id} allowClear={false} required/></> : <><h3>{draft.title}</h3><div className="suggestion-meta"><span>{goal?.title ?? 'Choose a valid goal'}</span>{draft.estimatedMinutes > 0 && <span>About {draft.estimatedMinutes} min</span>}{draft.existingTaskId && <span>Existing task</span>}</div><p>{draft.nextStep}</p><small>{draft.reason}</small>{!goal && <div className="relationship-repair"><AlertCircle size={14}/> The returned goal ID was not eligible. Select the relationship before adding.</div>}</>}
    <div className="suggestion-actions"><button className="primary" disabled={accepted || !goal || !draft.title.trim() || !draft.nextStep.trim()} onClick={accept}>{accepted ? 'Added to Today' : draft.existingTaskId ? 'Use on Today' : 'Add to Today'}</button><button onClick={() => setEditing(value => !value)}>{editing ? 'Preview' : 'Edit'}</button><button onClick={() => setDismissed(true)}>Dismiss</button></div>
  </article>
}

function ClarificationCard({ clarification, goals, onSubmit }: { clarification: { goalId: string; question: string }; goals: Goal[]; onSubmit: (goalId: string, answer: string) => void }) {
  const [goalId, setGoalId] = useState(goals.some(goal => goal.id === clarification.goalId && goal.status === 'active') ? clarification.goalId : '')
  const [answer, setAnswer] = useState('')
  if (!clarification.question.trim()) return null
  return <section className="clarification-card"><span>ONE QUESTION</span><h3>{clarification.question}</h3>{!goalId && <GoalPicker goals={goals} value={undefined} onChange={id => setGoalId(id ?? '')} allowClear={false} required/>}<textarea aria-label="Your answer" rows={3} value={answer} onChange={event => setAnswer(event.target.value)} placeholder="Answer with the missing detail"/><button className="primary wide" disabled={!goalId || !answer.trim()} onClick={() => onSubmit(goalId, answer)}>Use answer and revise suggestions</button></section>
}

function PlanAiResult({ result, selectedGoal, goals, onAcceptAction, onAcceptTitle, onAcceptMilestone, onAcceptEvidence, onAcceptLink, onClarification, onDismiss }: { result: AiPlanResult; selectedGoal?: Goal; goals: Goal[]; onAcceptAction: (suggestion: AiSuggestion) => boolean; onAcceptTitle: (title: string) => void; onAcceptMilestone: (title: string) => void; onAcceptEvidence: (value: string) => boolean; onAcceptLink: (value: string) => boolean; onClarification: (goalId: string, answer: string) => void; onDismiss: () => void }) {
  const [clarifiedGoal, setClarifiedGoal] = useState(result.clarifiedGoal)
  const [showTitle, setShowTitle] = useState(Boolean(selectedGoal))
  const [milestones, setMilestones] = useState(result.milestones)
  const [evidence, setEvidence] = useState(result.evidenceSuggestions)
  const [links, setLinks] = useState(result.goalLinks)
  return <div className="ai-result"><ClarificationCard clarification={result.clarification} goals={goals} onSubmit={onClarification}/>{showTitle && <div className="approval-item"><span>CLARIFIED GOAL</span><textarea rows={2} aria-label="Edit clarified goal" value={clarifiedGoal} onChange={event => setClarifiedGoal(event.target.value)}/><div><button disabled={!clarifiedGoal.trim()} onClick={() => { onAcceptTitle(clarifiedGoal); setShowTitle(false) }}>Use wording</button><button onClick={() => setShowTitle(false)}>Reject</button></div></div>}{result.suggestions.length > 0 && <section><span>NEXT ACTIONS</span>{result.suggestions.map(item => <SuggestionCard key={item.id} suggestion={item} goals={goals} onAccept={onAcceptAction}/>)}</section>}{milestones.length > 0 && <section><span>MILESTONES</span>{milestones.map((item, index) => <ApprovalItem key={`milestone:${index}`} value={item} label={`Edit milestone ${index + 1}`} onChange={value => setMilestones(values => values.map((current, itemIndex) => itemIndex === index ? value : current))} onAccept={value => { onAcceptMilestone(value); setMilestones(values => values.filter((_, itemIndex) => itemIndex !== index)) }} onReject={() => setMilestones(values => values.filter((_, itemIndex) => itemIndex !== index))}/>)}</section>}{evidence.length > 0 && <section><span>CAPTURE REMINDERS</span>{evidence.map((item, index) => <ApprovalItem key={`evidence:${index}`} value={item} label={`Edit reminder ${index + 1}`} onChange={value => setEvidence(values => values.map((current, itemIndex) => itemIndex === index ? value : current))} onAccept={value => { if (onAcceptEvidence(value)) setEvidence(values => values.filter((_, itemIndex) => itemIndex !== index)) }} onReject={() => setEvidence(values => values.filter((_, itemIndex) => itemIndex !== index))}/>)}</section>}{links.length > 0 && <section><span>RELATED GOALS</span>{links.map((item, index) => { const goal = goals.find(value => value.id === item.goalId); return <article className="link-suggestion" key={`${item.goalId}:${index}`}><b>{goal?.title ?? 'Unknown goal'}</b><p>{item.reason}</p><div><button disabled={!goal} onClick={() => { if (onAcceptLink(item.goalId)) setLinks(values => values.filter((_, itemIndex) => itemIndex !== index)) }}>Link</button><button onClick={() => setLinks(values => values.filter((_, itemIndex) => itemIndex !== index))}>Reject</button></div></article>})}</section>}{result.notes && <div className="ai-readable-notes"><span>NOTES</span><p>{result.notes}</p></div>}<button className="secondary wide" onClick={onDismiss}>Done</button></div>
}

function PerspectiveResult({ result, onDismiss }: { result: Extract<AiResult, { kind: 'week' | 'recap' }>; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => { try { await navigator.clipboard.writeText([result.summary, ...result.highlights, result.nextFocus].filter(Boolean).join('\n\n')); setCopied(true) } catch { setCopied(false) } }
  return <div className="ai-result perspective-result"><p>{result.summary}</p>{result.highlights.length > 0 && <section><span>HIGHLIGHTS</span>{result.highlights.map((item, index) => <p key={index}>✓ {item}</p>)}</section>}{result.nextFocus && <section><span>NEXT FOCUS</span><p>{result.nextFocus}</p></section>}<button className="secondary wide" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy perspective'}</button><button className="secondary wide" onClick={onDismiss}>Done</button></div>
}

function ApprovalItem({ value, label, onChange, onAccept, onReject }: { value: string; label: string; onChange: (value: string) => void; onAccept: (value: string) => void; onReject: () => void }) { return <div className="approval-item"><textarea rows={2} aria-label={label} value={value} onChange={event => onChange(event.target.value)}/><div><button disabled={!value.trim()} onClick={() => onAccept(value.trim())}>Add</button><button onClick={onReject}>Reject</button></div></div> }

function ProgressChart({ entries, emptyLabel = 'No observations yet' }: { entries: Array<{ value: number }>; emptyLabel?: string }) {
  if (!entries.length) return <div className="chart-empty"><TrendingUp size={18}/><span>{emptyLabel}</span></div>
  if (entries.length === 1) return <div className="chart-single"><i/><span>Starting point recorded</span></div>
  const values = entries.map(item => item.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max === min ? 1 : max - min
  const points = entries.map((item, index) => `${4 + index * (144 / (entries.length - 1))},${74 - ((item.value - min) / range) * 62}`).join(' ')
  return <svg className="chart" viewBox="0 0 152 82" preserveAspectRatio="none" aria-label={`Trend across ${entries.length} observations`}><polyline points={points} fill="none" stroke="#cde97d" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
}
function GoalProgress({ goal }: { goal: Goal }) { if (goal.kind !== 'numeric') return <span className="goal-state">{goal.status === 'completed' ? '✓ Complete' : goal.kind}</span>; if (goal.current === undefined) return <span className="goal-state">Set starting point</span>; const distance = goal.target === undefined || goal.baseline === undefined ? undefined : goal.target - goal.baseline; const percent = distance === undefined ? 0 : distance === 0 ? goal.current === goal.target ? 100 : 0 : Math.max(0, Math.min(100, ((goal.current - goal.baseline!) / distance) * 100)); return <div className="goal-measure"><span>{formatValue(goal.current, goal.unit)}</span><i><em style={{ width: `${percent}%` }}/></i><span>{goal.target === undefined ? 'No target' : formatValue(goal.target, goal.unit)}</span></div> }
const formatValue = (value: number, unit?: string) => unit === 'USD' ? money(value) : `${value}${unit ? ` ${unit}` : ''}`
const periodLabel = (period: PeriodRecord) => `${period.kind === 'week'
  ? `Week ending ${formatDate(period.end)}`
  : period.kind === 'month'
    ? new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(new Date(`${period.start}T12:00:00`))
    : `${period.kind === '3M' ? 'Three-month' : period.kind === '6M' ? 'Six-month' : 'Year'} recap · ${formatDate(period.start)} – ${formatDate(period.end)}`}${period.effectiveStart ? ' · partial' : ''}`
const recurrenceLabel = (routine: Routine) => routine.recurrence.type === 'daily' ? 'Every day' : routine.recurrence.type === 'weekdays' ? 'Weekdays' : (routine.recurrence.weekdays || []).map(day => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][day]).join(', ')
function downloadJson(value: unknown, name: string) { const url = URL.createObjectURL(new Blob([JSON.stringify(value)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = name; link.rel = 'noopener'; document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1_000) }
