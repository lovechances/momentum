import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle, ArrowDown, ArrowUp, CalendarDays, Camera, Check, ChevronLeft,
  ChevronRight, Circle, CirclePlus, Download, Goal as GoalIcon,
  Image, Layers3, Moon, Pause, Pencil, Plus, RotateCcw, Settings as SettingsIcon,
  Sparkles, Target, Trash2, TrendingUp, Upload, X,
} from 'lucide-react'
import type { AppData, Evidence, EvidenceKind, EvidenceSchedule, Goal, Horizon, PeriodRecord, Routine, Section, Task, Win } from './domain'
import { localDateOf, now, todayLocal } from './domain'
import { createGoal, deadlineFor, numericTargetReached, reviewDeadline, type DeadlineReason } from './goals'
import { calculateMomentum } from './momentum'
import { dueEvidence, addDays, orderRoutineTasksForDisplay, reconcileSchedule, rolloverCandidates } from './scheduler'
import { isMeaningfulRecap, recapFacts } from './recap'
import { compressImage } from './media'
import { allMedia, clearAll, deleteMedia, getMedia, mediaBytes, putMedia, replaceDatabase } from './storage'
import { createBackup, restoreMedia, validateBackup } from './backup'
import { AI_MODEL, applyMonthlyReset, canCallAi, recordAiResponse, aiRequest, validatePlan, type AiPlan } from './ai'
import { newEvidence, newProgress, newTask, useMomentumApp } from './useMomentumApp'

type Tab = 'today' | 'goals' | 'progress' | 'recap'
type Sheet = 'task' | 'goal' | 'routine-list' | 'routine-form' | 'capture' | 'number' | 'media' | 'milestone' | 'win' | 'settings' | 'goal-detail' | 'deadline' | 'evidence' | 'story' | 'momentum' | 'ai' | null

const horizons: Horizon[] = ['1M', '3M', '6M', '1Y', '2Y']
const sections: Section[] = ['Morning', 'Moves That Matter', 'Day', 'Evening']
const reasons: Array<[DeadlineReason, string]> = [['did-not-execute', "Didn't execute"], ['unrealistic', 'Goal unrealistic'], ['priorities-changed', 'Priorities changed'], ['blocked', 'Blocked'], ['no-longer-important', 'No longer important'], ['other', 'Other']]
const formatDate = (value: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(`${value}T12:00:00`))
const money = (value: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value)
const aiText = (value: string | undefined, max = 240) => value?.trim().slice(0, max)

function compactRecapForAi(data: AppData, period: PeriodRecord) {
  const facts = recapFacts(data, period)
  return {
    period: { kind: period.kind, start: period.start, end: period.end },
    momentum: facts.momentum,
    momentumStatus: facts.momentumStatus,
    goalMoves: facts.goalMoves,
    activeDays: facts.activeDays,
    evidenceCount: facts.evidenceCount,
    wins: facts.wins.slice(-8).map(item => aiText(item)),
    milestones: facts.milestones.slice(-8).map(item => aiText(item)),
    completedGoals: facts.completedGoals.slice(-8).map(item => aiText(item)),
    numeric: facts.numeric.slice(0, 10).map(item => ({ title: aiText(item.title), start: item.start, end: item.end, change: item.change, unit: aiText(item.unit, 32), observations: item.observations, hasComparison: item.hasComparison })),
    strongest: aiText(facts.strongest, 120),
    needsAttention: aiText(facts.needsAttention, 120),
  }
}

export default function App() {
  const { data, ready, storageError, actions } = useMomentumApp()
  const [tab, setTab] = useState<Tab>('today')
  const [sheet, setSheet] = useState<Sheet>(null)
  const [goalId, setGoalId] = useState<string>()
  const [routineId, setRoutineId] = useState<string>()
  const [evidenceId, setEvidenceId] = useState<string>()
  const [periodId, setPeriodId] = useState<string>()
  const [toast, setToast] = useState<string>()
  const [mediaSize, setMediaSize] = useState(0)
  const [mediaRevision, setMediaRevision] = useState(0)
  const [captureTarget, setCaptureTarget] = useState<{ goalId?: string; kind?: EvidenceKind; scheduleId?: string }>({})
  const [aiState, setAiState] = useState<{ loading: boolean; action?: 'plan' | 'today' | 'week' | 'recap'; result?: AiPlan; error?: string }>({ loading: false })
  const aiAbortRef = useRef<AbortController | undefined>(undefined)

  useEffect(() => { mediaBytes().then(setMediaSize).catch(() => undefined) }, [data.evidence.length, data.wins.length, mediaRevision])
  useEffect(() => { if (!toast) return; const id = window.setTimeout(() => setToast(undefined), 2800); return () => window.clearTimeout(id) }, [toast])
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
  const momentum = useMemo(() => calculateMomentum(data.tasks, data.goals, data.progress, date), [data.tasks, data.goals, data.progress, date])
  const evidenceDue = useMemo(() => data.settings.reminders.evidence ? dueEvidence(data.goals, data.evidence, date) : [], [data.goals, data.evidence, data.settings.reminders.evidence, date])
  const availablePeriods = useMemo(() => data.periods.filter(period => period.availableAt <= date && isMeaningfulRecap(data, period)).sort((a, b) => b.end.localeCompare(a.end)), [data, date])
  const selectedGoal = data.goals.find(goal => goal.id === goalId)
  const selectedRoutine = data.routines.find(routine => routine.id === routineId)
  const selectedEvidence = data.evidence.find(item => item.id === evidenceId)
  const selectedPeriod = data.periods.find(period => period.id === periodId) || availablePeriods[0]

  const openGoal = (id: string) => { setGoalId(id); setSheet('goal-detail') }
  const openRecap = (period: PeriodRecord) => { setPeriodId(period.id); setSheet('story') }
  const openAi = (action: 'plan' | 'today' | 'week' | 'recap', id?: string) => { if (id) setGoalId(id); setAiState({ loading: false, action }); setSheet('ai') }
  const openCapture = (target: { goalId?: string; kind?: EvidenceKind; scheduleId?: string } = {}) => {
    setCaptureTarget(target)
    setSheet(target.kind === 'number' ? 'number' : target.kind === 'photo' || target.kind === 'screenshot' ? 'media' : target.kind === 'milestone' ? 'milestone' : 'capture')
  }
  const openDeadline = (id: string) => { setGoalId(id); setSheet('deadline') }

  const runAi = async () => {
    const usage = applyMonthlyReset(data.settings.ai)
    if (!usage.enabled) { setAiState(state => ({ ...state, error: 'Enable optional AI in Settings first.' })); return }
    if (!canCallAi(usage, 0.01)) { setAiState(state => ({ ...state, error: 'Your monthly AI limit has been reached.' })); return }
    const action = aiState.action || 'plan'
    const context = action === 'plan' && selectedGoal
      ? { goal: { id: selectedGoal.id, title: aiText(selectedGoal.title), kind: selectedGoal.kind, horizon: selectedGoal.horizon, current: selectedGoal.current, target: selectedGoal.target, deadline: selectedGoal.deadline, nextAction: aiText(selectedGoal.nextAction) }, possibleLinks: data.goals.filter(goal => goal.id !== selectedGoal.id && goal.status === 'active').slice(0, 8).map(goal => ({ id: goal.id, title: aiText(goal.title), horizon: goal.horizon })) }
      : action === 'today'
        ? { activeGoals: data.goals.filter(goal => goal.status === 'active').slice(0, 10).map(goal => ({ id: goal.id, title: aiText(goal.title), horizon: goal.horizon, nextAction: aiText(goal.nextAction), deadline: goal.deadline })), unfinishedMoves: data.tasks.filter(task => task.kind === 'move' && !task.done && (task.status ?? 'active') === 'active' && task.dueDate <= date).slice(-5).map(task => ({ title: aiText(task.title), goalId: task.goalId })) }
        : { facts: selectedPeriod ? compactRecapForAi(data, selectedPeriod) : undefined }
    setAiState(state => ({ ...state, loading: true, error: undefined, result: undefined }))
    const controller = new AbortController()
    aiAbortRef.current?.abort()
    aiAbortRef.current = controller
    try {
      const response = await aiRequest(action, context, { signal: controller.signal })
      if (!validatePlan(response.output)) throw new Error('The AI response could not be validated.')
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

  const acceptAiAction = (actionTitle: string, acceptedGoalId?: string) => {
    const relatedGoalId = acceptedGoalId || selectedGoal?.id
    const relatedGoal = data.goals.find(goal => goal.id === relatedGoalId && goal.status === 'active')
    if (!relatedGoal) { setToast('Choose an active related goal before adding a Goal Move'); return }
    actions.addTask(newTask(actionTitle, 'move', 'Moves That Matter', relatedGoalId))
    setToast('Added to Moves That Matter')
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
    const kind: EvidenceKind | undefined = lower.includes('screenshot') ? 'screenshot' : lower.includes('photo') || lower.includes('picture') ? 'photo' : lower.includes('milestone') ? 'milestone' : /number|metric|measure|weight|weigh|balance|revenue|amount|total/.test(lower) ? 'number' : undefined
    const cadence: EvidenceSchedule['cadence'] | undefined = lower.includes('quarter') ? 'quarterly' : lower.includes('month') ? 'monthly' : lower.includes('week') ? 'weekly' : undefined
    if (!kind || !cadence) {
      setToast('Edit the suggestion to include weekly, monthly, or quarterly and a number, photo, screenshot, or milestone')
      return false
    }
    if (kind === 'number' && selectedGoal.kind !== 'numeric') {
      setToast('Number reminders require a numeric goal')
      return false
    }
    if (selectedGoal.evidenceSchedules.some(schedule => schedule.active && schedule.kind === kind && schedule.cadence === cadence)) {
      setToast('That evidence reminder is already active')
      return false
    }
    actions.updateGoal({ ...selectedGoal, evidenceSchedules: [...selectedGoal.evidenceSchedules, { id: crypto.randomUUID(), kind, cadence, active: true }] })
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
      {tab === 'today' && <TodayScreen data={data} momentum={momentum} evidenceDue={evidenceDue} reminders={schedule.reminders} onToggle={actions.toggleTask} onAdd={() => setSheet('task')} onGoal={openGoal} onCapture={() => openCapture()} onDueEvidence={(goalId, kind, scheduleId) => openCapture({ goalId, kind, scheduleId })} onDeadline={openDeadline} onPlanning={() => setTab('goals')} onRollover={actions.resolveRollover} onRestDay={actions.markRestDay} onRoutines={() => setSheet('routine-list')} onMomentum={() => setSheet('momentum')} onRecap={openRecap} onAi={() => openAi('today')}/>} 
      {tab === 'goals' && <GoalsScreen data={data} onOpen={openGoal} onAdd={() => setSheet('goal')}/>} 
      {tab === 'progress' && <ProgressScreen data={data} onCapture={() => openCapture()} onGoal={openGoal} onEvidence={() => { setEvidenceId(undefined); setSheet('evidence') }}/>} 
      {tab === 'recap' && <RecapScreen data={data} periods={availablePeriods} onOpen={openRecap} onAi={period => { setPeriodId(period.id); openAi(period.kind === 'week' ? 'week' : 'recap') }}/>} 
    </div>
    <nav aria-label="Primary">{([{ id: 'today', label: 'Today', icon: CalendarDays }, { id: 'goals', label: 'Goals', icon: GoalIcon }, { id: 'progress', label: 'Progress', icon: TrendingUp }, { id: 'recap', label: 'Recap', icon: Layers3 }] as const).map(item => { const Icon = item.icon; return <button key={item.id} className={tab === item.id ? 'active' : ''} aria-current={tab === item.id ? 'page' : undefined} onClick={() => setTab(item.id)}><Icon size={20}/><span>{item.label}</span></button> })}</nav>
    {sheet && <Sheet key={sheet} onClose={() => setSheet(null)}>
      {sheet === 'task' && <TaskForm goals={data.goals} onSave={task => { actions.addTask(task); setSheet(null); setToast(task.kind === 'move' ? 'Goal Move added' : 'Task added') }}/>} 
      {sheet === 'goal' && <GoalForm onSave={goal => { actions.addGoal(goal); setSheet(null); setToast('Goal added') }}/>} 
      {sheet === 'routine-list' && <RoutineManager routines={data.routines} onAdd={() => { setRoutineId(undefined); setSheet('routine-form') }} onEdit={id => { setRoutineId(id); setSheet('routine-form') }} onToggle={routine => actions.updateRoutine({ ...routine, active: !routine.active })} onDelete={async id => { if (window.confirm('Delete this routine? Past task history will remain.')) actions.deleteRoutine(id) }} onMove={actions.reorderRoutine}/>} 
      {sheet === 'routine-form' && <RoutineForm routine={selectedRoutine} onBack={() => setSheet('routine-list')} onSave={routine => { selectedRoutine ? actions.updateRoutine(routine) : actions.addRoutine(routine); setSheet('routine-list'); setToast('Routine saved') }}/>} 
      {sheet === 'capture' && <CaptureMenu canNumber={captureTarget.goalId ? data.goals.some(goal => goal.id === captureTarget.goalId && goal.kind === 'numeric' && goal.status === 'active') : data.goals.some(goal => goal.kind === 'numeric' && goal.status === 'active')} canMilestone={data.goals.some(goal => goal.status === 'active')} onNumber={() => setSheet('number')} onMedia={() => setSheet('media')} onMilestone={() => setSheet('milestone')} onWin={() => setSheet('win')}/>} 
      {sheet === 'number' && <NumberForm goals={data.goals} initialGoalId={captureTarget.goalId} onSave={(id, value, note) => {
        const targetGoal = data.goals.find(goal => goal.id === id && goal.status === 'active')
        const reachesTarget = targetGoal && numericTargetReached({ ...targetGoal, baseline: targetGoal.baseline ?? value, current: value })
        if (reachesTarget && !window.confirm(`${formatValue(value, targetGoal.unit)} reaches the target for “${targetGoal.title}” and will mark it complete. Save this update?`)) return
        const scheduleId = captureTarget.goalId === id && captureTarget.kind === 'number' ? captureTarget.scheduleId : undefined
        actions.addProgress(newProgress(id, value, note))
        actions.addEvidence({ ...newEvidence('number', id, undefined, note), scheduleId, value })
        setCaptureTarget({})
        setSheet(null)
        setToast(reachesTarget ? 'Progress saved and goal completed' : 'Progress updated')
      }}/>} 
      {sheet === 'media' && <MediaForm goals={data.goals} initialGoalId={captureTarget.goalId} initialKind={captureTarget.kind} onSave={async (kind, id, note, file) => { try { const media = await compressImage(file); await putMedia(media); const scheduleId = captureTarget.goalId === id && captureTarget.kind === kind ? captureTarget.scheduleId : undefined; actions.addEvidence({ ...newEvidence(kind, id, media, note), scheduleId }); setMediaRevision(value => value + 1); setCaptureTarget({}); setSheet(null); setToast('Evidence saved privately') } catch (error) { setToast(error instanceof Error ? error.message : 'That image could not be saved') } }}/>} 
      {sheet === 'milestone' && <MilestoneForm goals={data.goals} initialGoalId={captureTarget.goalId} onSave={(id, title, milestoneId) => {
        const targetGoal = data.goals.find(goal => goal.id === id && goal.status === 'active')
        if (!targetGoal) return
        const planned = milestoneId ? targetGoal.milestones.find(item => item.id === milestoneId && !item.done) : undefined
        const completesGoal = Boolean(planned && targetGoal.kind === 'milestone' && targetGoal.milestones.every(item => item.id === planned.id || item.done))
        if (completesGoal && !window.confirm(`“${planned!.title}” is the final milestone and will mark “${targetGoal.title}” complete. Save it?`)) return
        if (planned) actions.toggleMilestone(id, planned.id, true)
        const scheduleId = captureTarget.goalId === id && captureTarget.kind === 'milestone' ? captureTarget.scheduleId : undefined
        actions.addEvidence({ ...newEvidence('milestone', id, undefined, title), scheduleId, milestoneId: planned?.id })
        setCaptureTarget({})
        setSheet(null)
        setToast(completesGoal ? 'Milestone captured and goal completed' : 'Milestone captured')
      }}/>} 
      {sheet === 'win' && <WinForm goals={data.goals} initialGoalId={captureTarget.goalId} onSave={async (win, file) => { try { let mediaId: string | undefined; if (file) { const media = await compressImage(file); await putMedia(media); mediaId = media.id; setMediaRevision(value => value + 1) } actions.addWin({ ...win, mediaId }); setCaptureTarget({}); setSheet(null); setToast('Win captured for your recap') } catch (error) { setToast(error instanceof Error ? error.message : 'That win could not be saved') } }}/>} 
      {sheet === 'settings' && <SettingsPanel data={data} mediaSize={mediaSize} onRoutines={() => setSheet('routine-list')} onSettings={actions.setSettings} onExport={async includeMedia => { try { const backup = await createBackup(data, includeMedia ? await allMedia() : [], includeMedia); downloadJson(backup, includeMedia ? 'momentum-full-backup.json' : 'momentum-data-backup.json'); setToast('Backup download started') } catch { setToast('Backup could not be created. Your data was not changed.') } }} onImport={async file => { try { if (file.size > 120 * 1024 * 1024) throw new Error('That backup is too large to import safely on this device.'); const parsed = JSON.parse(await file.text()); if (!validateBackup(parsed)) throw new Error('This is not a valid Momentum backup.'); if (!window.confirm(`Replace the data on this device with this ${parsed.media ? 'full' : 'data-only'} backup?`)) return; const media = await restoreMedia(parsed); const snapshot = parsed.media ? parsed.data : { ...parsed.data, evidence: parsed.data.evidence.map(item => ({ ...item, mediaId: undefined })), wins: parsed.data.wins.map(item => ({ ...item, mediaId: undefined })) }; await replaceDatabase(snapshot, media); actions.replaceData(snapshot); setMediaRevision(value => value + 1); setSheet(null); setToast('Backup restored') } catch (error) { setToast(error instanceof Error ? error.message : 'Backup could not be restored. Your existing data is unchanged.') } }} onClear={async () => { if (!window.confirm('Restore Momentum to its first-run starter goals and routines, and permanently delete your tasks, updates, wins, custom goals/routines, and images?')) return; try { await clearAll(); actions.reset(); setMediaRevision(value => value + 1); setSheet(null); setToast('Momentum reset on this device') } catch { setToast('Local data could not be cleared. Nothing else was changed.') } }}/>} 
      {sheet === 'goal-detail' && selectedGoal && <GoalDetail goal={selectedGoal} allGoals={data.goals} evidence={data.evidence.filter(item => item.goalId === selectedGoal.id)} onChange={goal => goal.title !== selectedGoal.title || goal.nextAction !== selectedGoal.nextAction ? actions.editGoal(selectedGoal.id, { title: goal.title, nextAction: goal.nextAction }) : actions.updateGoal(goal)} onPause={() => selectedGoal.status === 'paused' ? actions.resumeGoal(selectedGoal.id) : actions.pauseGoal(selectedGoal.id)} onComplete={() => actions.completeGoal(selectedGoal.id)} onReopen={() => { if (window.confirm(`Reopen “${selectedGoal.title}” for correction? Its prior completion stays in history.`)) { actions.reopenGoal(selectedGoal.id); setToast('Goal reopened without erasing history') } }} onToggleMilestone={(id, done) => { const completesGoal = done && selectedGoal.kind === 'milestone' && selectedGoal.milestones.every(item => item.id === id || item.done); if (completesGoal && !window.confirm(`This is the final milestone and will mark “${selectedGoal.title}” complete. Continue?`)) return; actions.toggleMilestone(selectedGoal.id, id, done) }} onReview={() => setSheet('deadline')} onAi={() => openAi('plan', selectedGoal.id)} onCapture={() => openCapture({ goalId: selectedGoal.id })}/>} 
      {sheet === 'deadline' && selectedGoal && <DeadlineReview goal={selectedGoal} onBack={() => setSheet('goal-detail')} onSave={(action, reason, options) => { actions.updateGoal(reviewDeadline(selectedGoal, action, reason, options)); setSheet(null); setToast('Goal review saved without rewriting history') }}/>} 
      {sheet === 'evidence' && <EvidenceGallery evidence={data.evidence} goals={data.goals} onDelete={async item => { if (!window.confirm('Delete this evidence item? The related goal and numeric progress history will remain.')) return; try { const mediaShared = item.mediaId && (data.evidence.some(other => other.id !== item.id && other.mediaId === item.mediaId) || data.wins.some(win => win.mediaId === item.mediaId)); if (item.mediaId && !mediaShared) { await deleteMedia(item.mediaId); setMediaRevision(value => value + 1) } actions.deleteEvidence(item.id); setEvidenceId(undefined); setToast('Evidence deleted') } catch { setToast('Evidence could not be deleted. Your record was not changed.') } }} selected={selectedEvidence} onSelect={setEvidenceId}/>} 
      {sheet === 'story' && selectedPeriod && <Story data={data} period={selectedPeriod} onAi={() => openAi(selectedPeriod.kind === 'week' ? 'week' : 'recap')} onDone={() => { actions.setPeriodFinalized(selectedPeriod.id); setSheet(null) }}/>} 
      {sheet === 'momentum' && <MomentumDetail result={momentum}/>} 
      {sheet === 'ai' && <AiPanel state={aiState} settings={data.settings.ai} selectedGoal={aiState.action === 'plan' ? selectedGoal : undefined} goals={data.goals} onRun={runAi} onCancel={() => aiAbortRef.current?.abort()} onAcceptAction={acceptAiAction} onAcceptTitle={acceptAiTitle} onAcceptMilestone={acceptAiMilestone} onAcceptEvidence={acceptAiEvidence} onAcceptLink={acceptAiLink} onDismiss={() => { setAiState({ loading: false }); setSheet(null) }}/>} 
    </Sheet>}
    {toast && <div className="toast" role="status"><Check size={15}/>{toast}</div>}
  </main>
}

function TodayScreen({ data, momentum, evidenceDue, reminders, onToggle, onAdd, onGoal, onCapture, onDueEvidence, onDeadline, onPlanning, onRollover, onRestDay, onRoutines, onMomentum, onRecap, onAi }: { data: AppData; momentum: ReturnType<typeof calculateMomentum>; evidenceDue: ReturnType<typeof dueEvidence>; reminders: ReturnType<typeof reconcileSchedule>['reminders']; onToggle: (id: string) => void; onAdd: () => void; onGoal: (id: string) => void; onCapture: () => void; onDueEvidence: (goalId: string, kind: EvidenceKind, scheduleId: string) => void; onDeadline: (goalId: string) => void; onPlanning: () => void; onRollover: (id: string, action: 'carry' | 'drop', date?: string) => void; onRestDay: (date: string, rest: boolean) => void; onRoutines: () => void; onMomentum: () => void; onRecap: (period: PeriodRecord) => void; onAi: () => void }) {
  const date = todayLocal()
  const tasks = data.tasks.filter(task => task.dueDate === date)
  const rollovers = rolloverCandidates(data.tasks, date)
  const recapReminders = reminders.filter(item => item.kind === 'recap')
  const deadlineReminders = reminders.filter(item => item.kind === 'deadline')
  const planningReminders = reminders.filter(item => item.kind === 'planning')
  const lightDay = tasks.length > 0 && tasks.every(task => task.lightDay)
  const [showAllDue, setShowAllDue] = useState(false)
  const hiddenDue = Math.max(0, deadlineReminders.length - 3) + Math.max(0, evidenceDue.length - 3) + Math.max(0, recapReminders.length - 2)
  return <>
    <header className="page-head"><p>{new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date())}</p><h1>Good morning<span className="warm-dot">.</span></h1></header>
    <button className="momentum-card" onClick={onMomentum}><div><span className="label">MOMENTUM</span>{momentum.status === 'building' ? <b className="building">Building baseline</b> : <strong>{momentum.score}</strong>}<small>{momentum.eligibleDays} eligible day{momentum.eligibleDays === 1 ? '' : 's'} · trailing 14 days</small></div><ChevronRight size={17}/></button>
    {(evidenceDue.length > 0 || recapReminders.length > 0 || deadlineReminders.length > 0 || planningReminders.length > 0) && <section className="due-box"><span className="label">DUE FOR YOU</span>{deadlineReminders.slice(0, showAllDue ? undefined : 3).map(reminder => <button key={reminder.id} onClick={() => onDeadline(reminder.id.replace('deadline:', ''))}><AlertCircle size={16}/><span><b>{reminder.title}</b><small>{reminder.detail}</small></span><ChevronRight size={15}/></button>)}{evidenceDue.slice(0, showAllDue ? undefined : 3).map(({ goal, schedule, dueDate }) => <button key={`${goal.id}:${schedule.id}`} onClick={() => onDueEvidence(goal.id, schedule.kind, schedule.id)}><Camera size={16}/><span><b>{schedule.cadence} {schedule.kind} due</b><small>{goal.title}{schedule.lastCapturedAt ? ` · last ${new Date(schedule.lastCapturedAt).toLocaleDateString()}` : ` · due ${formatDate(dueDate)}`}</small></span><ChevronRight size={15}/></button>)}{planningReminders.map(reminder => <button key={reminder.id} onClick={onPlanning}><CalendarDays size={16}/><span><b>{reminder.title}</b><small>{reminder.detail}</small></span><ChevronRight size={15}/></button>)}{recapReminders.slice(0, showAllDue ? undefined : 2).map(reminder => { const period = data.periods.find(item => `recap:${item.id}` === reminder.id); return period ? <button key={reminder.id} onClick={() => onRecap(period)}><Layers3 size={16}/><span><b>{reminder.title}</b><small>See the receipts</small></span><ChevronRight size={15}/></button> : null })}{(hiddenDue > 0 || showAllDue) && <button className="due-more" aria-expanded={showAllDue} onClick={() => setShowAllDue(value => !value)}>{showAllDue ? 'Show fewer due items' : `Show ${hiddenDue} more due item${hiddenDue === 1 ? '' : 's'}`}</button>}</section>}
    {rollovers.length > 0 && <section className="rollover"><span className="label">UNFINISHED</span>{rollovers.map(task => <div key={task.id}><span><b>{task.title}</b><small>{task.carriedCount ? `Moved ${task.carriedCount} time${task.carriedCount === 1 ? '' : 's'}` : `From ${formatDate(task.dueDate)}`}</small></span><div className="rollover-actions"><button aria-label={`Move ${task.title} to today`} onClick={() => onRollover(task.id, 'carry', date)}>Today</button><button aria-label={`Move ${task.title} to tomorrow`} onClick={() => onRollover(task.id, 'carry', addDays(date, 1))}>Tomorrow</button><button aria-label={`Drop ${task.title}`} onClick={() => onRollover(task.id, 'drop', date)}>Drop</button></div></div>)}</section>}
    <div className="today-heading"><span className="section-kicker">TODAY</span><span>{tasks.filter(task => task.done).length}/{tasks.length} done</span></div>
    {sections.map(section => { const group = orderRoutineTasksForDisplay(tasks.filter(task => task.section === section), data.routines); if (!group.length) return null; return <section className={`task-section ${section === 'Moves That Matter' ? 'moves' : ''}`} key={section}><h2>{section}{section === 'Moves That Matter' && <span>Where your day leads</span>}</h2>{group.map(task => <div className={`task ${task.done ? 'done' : ''}`} key={task.id}><button className="task-toggle" aria-label={`${task.done ? 'Uncheck' : 'Complete'} ${task.title}`} aria-pressed={task.done} onClick={() => onToggle(task.id)}><span className="check">{task.done && <Check size={14}/>}</span></button>{task.goalId ? <button className="task-copy" onClick={() => onGoal(task.goalId!)}><b>{task.title}</b><small>{data.goals.find(goal => goal.id === task.goalId)?.title}<ChevronRight size={11}/></small></button> : <div className="task-copy"><b>{task.title}</b></div>}{task.kind === 'move' && <Target className="move-mark" size={14}/>}</div>)}</section> })}
    <button className="add-row" onClick={onAdd}><CirclePlus size={19}/> Add task</button>
    <div className="today-actions"><button onClick={onCapture}><TrendingUp size={15}/> Update progress</button><button onClick={onAi}><Sparkles size={15}/> Suggest today’s moves</button><button onClick={onRoutines}><RotateCcw size={15}/> Manage routines</button><button aria-pressed={lightDay} disabled={!tasks.length} title={!tasks.length ? 'There are no commitments to mark as a light day.' : undefined} onClick={() => onRestDay(date, !lightDay)}><Moon size={15}/> {!tasks.length ? 'No commitments to mark' : lightDay ? 'Resume normal day' : 'Mark light / rest day'}</button></div>
  </>
}

function GoalsScreen({ data, onOpen, onAdd }: { data: AppData; onOpen: (id: string) => void; onAdd: () => void }) {
  const [horizon, setHorizon] = useState<Horizon>('1M')
  const [showClosed, setShowClosed] = useState(false)
  const closedCount = data.goals.filter(goal => goal.horizon === horizon && goal.status === 'closed').length
  const goals = data.goals.filter(goal => goal.horizon === horizon && (showClosed || goal.status !== 'closed'))
  return <><header className="page-head goal-head"><p>Planning horizon</p><h1>Goals</h1></header><div className="horizons" aria-label="Goal horizon">{horizons.map(item => <button key={item} className={item === horizon ? 'chosen' : ''} aria-pressed={item === horizon} onClick={() => setHorizon(item)}>{item}</button>)}</div><div className="goal-list">{goals.map(goal => <button className="goal-card" key={goal.id} onClick={() => onOpen(goal.id)}><span className={`area-dot ${goal.color}`}/><div><b>{goal.title}</b><small>{goal.status === 'completed' ? 'Completed' : goal.status === 'closed' ? 'Closed · kept in history' : `${goal.area || 'No area'} · ${formatDate(goal.deadline)}`}</small><GoalProgress goal={goal}/></div><ChevronRight size={18}/></button>)}</div>{closedCount > 0 && <button className="secondary wide archive-toggle" aria-pressed={showClosed} onClick={() => setShowClosed(value => !value)}>{showClosed ? 'Hide' : 'Show'} closed goals ({closedCount})</button>}<button className="primary add-goal" onClick={onAdd}><Plus size={18}/> Add a goal</button></>
}

function ProgressScreen({ data, onCapture, onGoal, onEvidence }: { data: AppData; onCapture: () => void; onGoal: (id: string) => void; onEvidence: () => void }) {
  const numeric = data.goals.filter(goal => goal.kind === 'numeric' && goal.status !== 'closed')
  return <><header className="page-head"><p>What has changed</p><h1>Progress</h1></header><div className="progress-hero"><div><span className="label">YOUR RECEIPTS</span><b>{data.progress.length ? 'Objective movement, captured.' : 'The story starts with your first update.'}</b></div><TrendingUp size={24}/></div>{numeric.map(goal => { const points = data.progress.filter(entry => entry.goalId === goal.id).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt)); return <section className="metric" key={goal.id}><button className="metric-top" onClick={() => onGoal(goal.id)}><div className={`metric-icon ${goal.color}`}><TrendingUp size={19}/></div><div><span>{goal.area || 'GOAL'}</span><b>{goal.current === undefined ? 'Set starting point' : formatValue(goal.current, goal.unit)}</b><small>{goal.target === undefined ? 'No target set' : `Target ${formatValue(goal.target, goal.unit)}`}</small></div><ChevronRight size={17}/></button><ProgressChart entries={points}/><div className="metric-foot"><span>{points.length} update{points.length === 1 ? '' : 's'}</span><span>{goal.baseline === undefined || goal.current === undefined ? 'No progress recorded yet' : `${goal.current - goal.baseline >= 0 ? '+' : ''}${goal.current - goal.baseline} ${goal.unit || ''} since start`}</span></div></section> })}<section className="wins-inline"><span className="label">RECENT WINS</span>{data.wins.slice(-3).reverse().map(win => <b key={win.id}>✓ {win.title}</b>)}{!data.wins.length && <small>Wins you capture will appear here and in Recap.</small>}</section><button className="evidence-link" onClick={onEvidence}><Camera size={17}/> Evidence library <span>{data.evidence.length} items</span><ChevronRight size={16}/></button><button className="primary wide capture-button" onClick={onCapture}><Plus size={18}/> Update progress</button></>
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

function TaskForm({ goals, onSave }: { goals: Goal[]; onSave: (task: Task) => void }) { const [title, setTitle] = useState(''); const [move, setMove] = useState(false); const [goalId, setGoalId] = useState(''); const [section, setSection] = useState<Section>('Day'); return <div className="sheet form-sheet"><span className="label">NEW TASK</span><h2>What needs doing?</h2><input autoFocus aria-label="Task title" value={title} onChange={event => setTitle(event.target.value)} placeholder="e.g. Grocery store"/><button className={`toggle ${move ? 'on' : ''}`} aria-pressed={move} onClick={() => { const next = !move; setMove(next); setSection(next ? 'Moves That Matter' : 'Day'); if (!next) setGoalId('') }}><span><Target size={16}/> This is a Goal Move</span><i/></button>{move && <select aria-label="Related goal" value={goalId} onChange={event => setGoalId(event.target.value)}><option value="">Choose related goal</option>{goals.filter(goal => goal.status === 'active').map(goal => <option value={goal.id} key={goal.id}>{goal.title}</option>)}</select>} {!move && <select aria-label="Today section" value={section} onChange={event => setSection(event.target.value as Section)}>{sections.filter(item => item !== 'Moves That Matter').map(item => <option key={item}>{item}</option>)}</select>}<button className="primary wide" disabled={!title.trim() || (move && !goalId)} onClick={() => onSave(newTask(title, move ? 'move' : 'task', move ? 'Moves That Matter' : section, goalId || undefined))}>Add to today</button></div> }

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

function GoalForm({ onSave }: { onSave: (goal: Goal) => void }) {
  const [title, setTitle] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const inferred = inferGoal(title)
  const [horizon, setHorizon] = useState<Horizon>()
  const [kind, setKind] = useState<Goal['kind']>()
  const [area, setArea] = useState<string>()
  const [baseline, setBaseline] = useState('')
  const [target, setTarget] = useState('')
  const [deadline, setDeadline] = useState('')
  const selectedHorizon = horizon || inferred.horizon
  const selectedKind = kind || inferred.kind
  const selectedArea = area ?? inferred.area
  const displayedTarget = selectedKind === 'numeric' ? (target === '' ? inferred.target : Number(target)) : undefined
  const validBaseline = selectedKind !== 'numeric' || baseline === '' || Number.isFinite(Number(baseline))
  const validTarget = selectedKind !== 'numeric' || target === '' || Number.isFinite(Number(target))
  return <div className="sheet form-sheet"><span className="label">NEW GOAL</span><h2>What do you want?</h2><input autoFocus aria-label="Goal title" value={title} onChange={event => setTitle(event.target.value)} placeholder="$10k stacked in 3 months"/>{title && <div className="inference"><b>{title}</b><span>{selectedHorizon} · {displayedTarget === undefined ? 'Outcome goal' : `Target ${displayedTarget}`} · {deadline || deadlineFor(selectedHorizon)}</span></div>}<button className="secondary wide" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>{advanced ? 'Hide adjustments' : 'Adjust / More options'}</button>{advanced && <div className="advanced"><label>Horizon<select value={selectedHorizon} onChange={event => setHorizon(event.target.value as Horizon)}>{horizons.map(item => <option key={item}>{item}</option>)}</select></label><label>Goal type<select value={selectedKind} onChange={event => setKind(event.target.value as Goal['kind'])}><option value="numeric">Numeric</option><option value="binary">Done / not done</option><option value="milestone">Milestone</option><option value="consistency">Consistency</option><option value="qualitative">Qualitative</option></select></label><label>Area<select value={selectedArea || ''} onChange={event => setArea(event.target.value)}><option value="">No area</option><option>Money</option><option>Business</option><option>Body</option><option>Life</option></select></label>{selectedKind === 'numeric' && <><label>Starting point<input inputMode="decimal" value={baseline} onChange={event => setBaseline(event.target.value)}/></label><label>Target<input inputMode="decimal" value={target} onChange={event => setTarget(event.target.value)}/></label></>}<label>Deadline<input type="date" value={deadline || deadlineFor(selectedHorizon)} onChange={event => setDeadline(event.target.value)}/></label></div>}<button className="primary wide" disabled={!title.trim() || !validBaseline || !validTarget} onClick={() => { const start = selectedKind === 'numeric' && baseline !== '' ? Number(baseline) : undefined; const finalTarget = selectedKind === 'numeric' && displayedTarget !== undefined && Number.isFinite(displayedTarget) ? displayedTarget : undefined; const color = selectedArea === 'Body' ? 'lime' : selectedArea === 'Money' ? 'gold' : selectedArea === 'Business' ? 'violet' : 'sky'; onSave({ ...createGoal({ title, horizon: selectedHorizon, kind: selectedKind, area: selectedArea, baseline: start, target: finalTarget, unit: selectedKind === 'numeric' && finalTarget !== undefined ? inferred.unit : undefined, color }), deadline: deadline || deadlineFor(selectedHorizon) }) }}>Looks right</button></div>
}

function RoutineManager({ routines, onAdd, onEdit, onToggle, onDelete, onMove }: { routines: Routine[]; onAdd: () => void; onEdit: (id: string) => void; onToggle: (routine: Routine) => void; onDelete: (id: string) => void; onMove: (id: string, direction: -1 | 1) => void }) { return <div className="sheet"><span className="label">AUTOMATIC TODAY</span><h2>Routines</h2>{routines.map((routine, index) => <div className="manage-row" key={routine.id}><button className={`switch ${routine.active ? 'on' : ''}`} aria-label={`${routine.active ? 'Pause' : 'Resume'} ${routine.title}`} aria-pressed={routine.active} onClick={() => onToggle(routine)}><i/></button><button className="manage-main" onClick={() => onEdit(routine.id)}><b>{routine.title}</b><small>{routine.section} · {recurrenceLabel(routine)}</small></button><button disabled={index === 0} aria-label={`Move ${routine.title} up`} onClick={() => onMove(routine.id, -1)}><ArrowUp size={14}/></button><button disabled={index === routines.length - 1} aria-label={`Move ${routine.title} down`} onClick={() => onMove(routine.id, 1)}><ArrowDown size={14}/></button><button aria-label={`Delete ${routine.title}`} onClick={() => onDelete(routine.id)}><Trash2 size={14}/></button></div>)}<button className="primary wide" onClick={onAdd}><Plus size={17}/> Add routine</button></div> }
function RoutineForm({ routine, onBack, onSave }: { routine?: Routine; onBack: () => void; onSave: (routine: Routine) => void }) { const [title, setTitle] = useState(routine?.title || ''); const [section, setSection] = useState<Section>(routine?.section || 'Morning'); const [recurrence, setRecurrence] = useState<Routine['recurrence']['type']>(routine?.recurrence.type || 'daily'); const [weekdays, setWeekdays] = useState<number[]>(routine?.recurrence.weekdays || [1, 3, 5]); return <div className="sheet form-sheet"><button className="back" onClick={onBack}><ChevronLeft size={16}/> Routines</button><h2>{routine ? 'Edit routine' : 'New routine'}</h2><input autoFocus aria-label="Routine name" value={title} onChange={event => setTitle(event.target.value)} placeholder="Routine name"/><label>Today section<select value={section} onChange={event => setSection(event.target.value as Section)}>{sections.filter(item => item !== 'Moves That Matter').map(item => <option key={item}>{item}</option>)}</select></label><label>Repeats<select value={recurrence} onChange={event => setRecurrence(event.target.value as Routine['recurrence']['type'])}><option value="daily">Every day</option><option value="weekdays">Weekdays</option><option value="weekdays-custom">Specific weekdays</option></select></label>{recurrence === 'weekdays-custom' && <div className="weekday-row" aria-label="Repeat on">{['S','M','T','W','T','F','S'].map((label, day) => <button type="button" key={day} className={weekdays.includes(day) ? 'selected' : ''} aria-label={['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][day]} aria-pressed={weekdays.includes(day)} onClick={() => setWeekdays(value => value.includes(day) ? value.filter(item => item !== day) : [...value, day])}>{label}</button>)}</div>}<button className="primary wide" disabled={!title.trim() || (recurrence === 'weekdays-custom' && !weekdays.length)} onClick={() => onSave({ id: routine?.id || crypto.randomUUID(), title: title.trim(), section, recurrence: { type: recurrence, weekdays: recurrence === 'weekdays-custom' ? weekdays : undefined }, active: routine?.active ?? true, goalId: routine?.goalId, createdAt: routine?.createdAt || now() })}>Save routine</button></div> }

function CaptureMenu({ canNumber, canMilestone, onNumber, onMedia, onMilestone, onWin }: { canNumber: boolean; canMilestone: boolean; onNumber: () => void; onMedia: () => void; onMilestone: () => void; onWin: () => void }) { return <div className="sheet capture-sheet"><span className="label">CAPTURE PROGRESS</span><h2>What changed?</h2><p>One update is enough. It will be ready for your recap.</p>{canNumber && <button onClick={onNumber}><TrendingUp/> Update a number <ChevronRight size={17}/></button>}<button onClick={onMedia}><Camera/> Photo or screenshot <ChevronRight size={17}/></button><button disabled={!canMilestone} title={canMilestone ? undefined : 'Add an active goal before recording a milestone.'} onClick={onMilestone}><Check/> Record a milestone <ChevronRight size={17}/></button><button onClick={onWin}><Sparkles/> Capture a win <ChevronRight size={17}/></button></div> }
function NumberForm({ goals, initialGoalId, onSave }: { goals: Goal[]; initialGoalId?: string; onSave: (goalId: string, value: number, note?: string) => void }) { const numeric = goals.filter(goal => goal.kind === 'numeric' && goal.status === 'active'); const [id, setId] = useState(numeric.some(goal => goal.id === initialGoalId) ? initialGoalId! : numeric[0]?.id || ''); const [value, setValue] = useState(''); const [note, setNote] = useState(''); if (!numeric.length) return <div className="sheet form-sheet"><span className="label">UPDATE NUMBER</span><h2>No active numeric goals.</h2><p>Add a numeric goal first, then its observations will build a real chart.</p></div>; return <div className="sheet form-sheet"><span className="label">UPDATE NUMBER</span><h2>Record where you are.</h2><select aria-label="Goal to update" value={id} onChange={event => setId(event.target.value)}>{numeric.map(goal => <option value={goal.id} key={goal.id}>{goal.title}</option>)}</select><input autoFocus aria-label="Current value" inputMode="decimal" value={value} onChange={event => setValue(event.target.value)} placeholder="Current value"/><input aria-label="Optional note" value={note} onChange={event => setNote(event.target.value)} placeholder="Optional note"/><button className="primary wide" disabled={!id || !Number.isFinite(Number(value)) || value.trim() === ''} onClick={() => onSave(id, Number(value), note.trim() || undefined)}>Save update</button></div> }
function MilestoneForm({ goals, initialGoalId, onSave }: { goals: Goal[]; initialGoalId?: string; onSave: (goalId: string, title: string, milestoneId?: string) => void }) {
  const activeGoals = goals.filter(goal => goal.status === 'active')
  const [goalId, setGoalId] = useState(activeGoals.some(goal => goal.id === initialGoalId) ? initialGoalId! : activeGoals[0]?.id || '')
  const [milestoneId, setMilestoneId] = useState('')
  const [title, setTitle] = useState('')
  const selectedGoal = activeGoals.find(goal => goal.id === goalId)
  const openMilestones = selectedGoal?.milestones.filter(item => !item.done) || []
  const selectedMilestone = openMilestones.find(item => item.id === milestoneId)
  const capturedTitle = selectedMilestone?.title || title.trim()
  if (!activeGoals.length) return <div className="sheet form-sheet"><span className="label">MILESTONE</span><h2>No active goals.</h2><p>Add or reopen a goal before recording a milestone.</p></div>
  return <div className="sheet form-sheet"><span className="label">MILESTONE</span><h2>What milestone did you reach?</h2><select aria-label="Related goal" value={goalId} onChange={event => { setGoalId(event.target.value); setMilestoneId('') }}>{activeGoals.map(goal => <option value={goal.id} key={goal.id}>{goal.title}</option>)}</select>{openMilestones.length > 0 && <label>Planned milestone<select aria-label="Planned milestone" value={milestoneId} onChange={event => { setMilestoneId(event.target.value); if (event.target.value) setTitle('') }}><option value="">Another milestone</option>{openMilestones.map(item => <option value={item.id} key={item.id}>{item.title}</option>)}</select></label>}{!selectedMilestone && <input autoFocus aria-label="Milestone reached" value={title} onChange={event => setTitle(event.target.value)} placeholder="e.g. Production validation finished"/>}<button className="primary wide" disabled={!goalId || !capturedTitle} onClick={() => onSave(goalId, capturedTitle, selectedMilestone?.id)}>Save milestone</button></div>
}
function MediaForm({ goals, initialGoalId, initialKind, onSave }: { goals: Goal[]; initialGoalId?: string; initialKind?: EvidenceKind; onSave: (kind: EvidenceKind, goalId: string | undefined, note: string | undefined, file: File) => Promise<void> }) {
  const [kind, setKind] = useState<EvidenceKind>(initialKind === 'screenshot' ? 'screenshot' : 'photo')
  const [goalId, setGoalId] = useState(initialGoalId || '')
  const [note, setNote] = useState('')
  const [file, setFile] = useState<File>()
  const [saving, setSaving] = useState(false)
  const save = async () => {
    if (!file || saving) return
    setSaving(true)
    try { await onSave(kind, goalId || undefined, note.trim() || undefined, file) } finally { setSaving(false) }
  }
  return <div className="sheet form-sheet"><span className="label">ADD EVIDENCE</span><h2>Keep the receipt.</h2><select aria-label="Evidence type" value={kind} disabled={saving} onChange={event => setKind(event.target.value as EvidenceKind)}><option value="photo">Photo</option><option value="screenshot">Screenshot</option></select><select aria-label="Related goal" value={goalId} disabled={saving} onChange={event => setGoalId(event.target.value)}><option value="">No related goal</option>{goals.filter(goal => goal.status === 'active').map(goal => <option value={goal.id} key={goal.id}>{goal.title}</option>)}</select><label className="file-picker"><Image size={18}/>{file ? file.name : 'Take or choose image'}<input type="file" accept="image/*" disabled={saving} onChange={event => setFile(event.target.files?.[0])}/></label><input aria-label="Optional note" value={note} disabled={saving} onChange={event => setNote(event.target.value)} placeholder="Optional note"/><button className="primary wide" disabled={!file || saving} onClick={() => void save()}>{saving ? 'Compressing and saving…' : 'Save privately'}</button></div>
}
function WinForm({ goals, initialGoalId, onSave }: { goals: Goal[]; initialGoalId?: string; onSave: (win: Win, file?: File) => Promise<void> }) {
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [goalId, setGoalId] = useState(initialGoalId || '')
  const [file, setFile] = useState<File>()
  const [saving, setSaving] = useState(false)
  const save = async () => {
    if (!title.trim() || saving) return
    setSaving(true)
    try { await onSave({ id: crypto.randomUUID(), title: title.trim(), note: note.trim() || undefined, goalId: goalId || undefined, createdAt: now() }, file) } finally { setSaving(false) }
  }
  return <div className="sheet form-sheet"><span className="label">CAPTURE WIN</span><h2>What happened?</h2><input autoFocus aria-label="Win title" value={title} disabled={saving} onChange={event => setTitle(event.target.value)} placeholder="e.g. First online sale"/><input aria-label="Optional win note" value={note} disabled={saving} onChange={event => setNote(event.target.value)} placeholder="Optional note"/><select aria-label="Related goal" value={goalId} disabled={saving} onChange={event => setGoalId(event.target.value)}><option value="">No related goal</option>{goals.map(goal => <option value={goal.id} key={goal.id}>{goal.title}</option>)}</select><label className="file-picker"><Camera size={18}/>{file ? file.name : 'Optional photo or screenshot'}<input type="file" accept="image/*" disabled={saving} onChange={event => setFile(event.target.files?.[0])}/></label><button className="primary wide" disabled={!title.trim() || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save win'}</button></div>
}

function GoalDetail({ goal, allGoals, evidence, onChange, onPause, onComplete, onReopen, onToggleMilestone, onReview, onAi, onCapture }: { goal: Goal; allGoals: Goal[]; evidence: Evidence[]; onChange: (goal: Goal) => void; onPause: () => void; onComplete: () => void; onReopen: () => void; onToggleMilestone: (id: string, done: boolean) => void; onReview: () => void; onAi: () => void; onCapture: () => void }) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(goal.title)
  const [next, setNext] = useState(goal.nextAction || '')
  const [milestoneTitle, setMilestoneTitle] = useState('')
  const [addingSchedule, setAddingSchedule] = useState(false)
  const [scheduleKind, setScheduleKind] = useState<EvidenceKind>(goal.kind === 'numeric' ? 'number' : 'screenshot')
  const [scheduleCadence, setScheduleCadence] = useState<EvidenceSchedule['cadence']>('monthly')
  const linkedGoals = goal.links.flatMap(id => allGoals.find(item => item.id === id) || [])
  const terminal = goal.status === 'completed' || goal.status === 'closed'
  const matchingSchedule = goal.evidenceSchedules.find(schedule => schedule.kind === scheduleKind && schedule.cadence === scheduleCadence)
  const saveSchedule = () => {
    if (matchingSchedule?.active) return
    const evidenceSchedules = matchingSchedule
      ? goal.evidenceSchedules.map(schedule => schedule.id === matchingSchedule.id ? { ...schedule, active: true } : schedule)
      : [...goal.evidenceSchedules, { id: crypto.randomUUID(), kind: scheduleKind, cadence: scheduleCadence, firstDueDate: todayLocal(), active: true }]
    onChange({ ...goal, evidenceSchedules })
    setAddingSchedule(false)
  }
  return <div className="sheet detail-sheet">
    <span className="label">{goal.horizon} · {goal.status.toUpperCase()}</span>
    <h2>{goal.title}</h2>
    <GoalProgress goal={goal}/>
    <div className="detail-section"><span>DEADLINE</span><b>{formatDate(goal.deadline)}</b></div>
    <div className="detail-section"><span>NEXT</span><b>{goal.nextAction || (terminal ? 'No next action — this goal is historical.' : 'Choose the next meaningful action')}</b></div>
    {goal.milestones.length > 0 && <div className="detail-section milestone-list"><span>PATH</span>{goal.milestones.map(item => <button key={item.id} aria-pressed={item.done} disabled={terminal} onClick={() => onToggleMilestone(item.id, !item.done)}>{item.done ? <Check size={15}/> : <Circle size={15}/>} {item.title}</button>)}</div>}
    {linkedGoals.length > 0 && <div className="detail-section"><span>WHERE THIS LEADS</span>{linkedGoals.map(link => <b key={link.id}>→ {link.title}</b>)}</div>}
    <div className="detail-section schedule-list"><span>EVIDENCE REMINDERS</span>{goal.evidenceSchedules.length === 0 && !addingSchedule && <small>No reminders yet.</small>}{goal.evidenceSchedules.map(schedule => { const referenced = evidence.some(item => item.scheduleId === schedule.id); return <div key={schedule.id}><b>{schedule.cadence} {schedule.kind}</b><button aria-pressed={schedule.active} disabled={terminal} onClick={() => onChange({ ...goal, evidenceSchedules: goal.evidenceSchedules.map(item => item.id === schedule.id ? { ...item, active: !item.active } : item) })}>{schedule.active ? 'Pause' : 'Resume'}</button>{referenced ? <small>Kept for history</small> : <button disabled={terminal} onClick={() => window.confirm(`Remove the ${schedule.cadence} ${schedule.kind} reminder?`) && onChange({ ...goal, evidenceSchedules: goal.evidenceSchedules.filter(item => item.id !== schedule.id) })}>Remove</button>}</div> })}{goal.status === 'active' && !addingSchedule && <button className="schedule-add" onClick={() => setAddingSchedule(true)}><Plus size={14}/> Add reminder</button>}{goal.status === 'active' && addingSchedule && <div className="schedule-creator"><label>Kind<select aria-label="Evidence reminder kind" value={scheduleKind} onChange={event => setScheduleKind(event.target.value as EvidenceKind)}>{goal.kind === 'numeric' && <option value="number">Number</option>}<option value="photo">Photo</option><option value="screenshot">Screenshot</option><option value="milestone">Milestone</option></select></label><label>Cadence<select aria-label="Evidence reminder cadence" value={scheduleCadence} onChange={event => setScheduleCadence(event.target.value as EvidenceSchedule['cadence'])}><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option></select></label><div><button onClick={() => setAddingSchedule(false)}>Cancel</button><button disabled={Boolean(matchingSchedule?.active)} onClick={saveSchedule}>{matchingSchedule?.active ? 'Already active' : matchingSchedule ? 'Resume reminder' : 'Add reminder'}</button></div></div>}</div>
    <div className="goal-actions">
      {goal.status === 'active' && <button onClick={onCapture}><TrendingUp size={15}/> Update</button>}
      {goal.status === 'active' && <button onClick={onAi}><Sparkles size={15}/> Help me plan</button>}
      {!terminal && <button aria-pressed={editing} onClick={() => setEditing(!editing)}><Pencil size={15}/> Edit</button>}
      {!terminal && <button aria-pressed={goal.status === 'paused'} onClick={onPause}>{goal.status === 'paused' ? <RotateCcw size={15}/> : <Pause size={15}/>} {goal.status === 'paused' ? 'Resume' : 'Pause'}</button>}
      {!terminal && <button onClick={() => window.confirm(`Mark “${goal.title}” complete?`) && onComplete()}><Check size={15}/> Complete</button>}
      {goal.status === 'completed' && <button onClick={onReopen}><RotateCcw size={15}/> Reopen for correction</button>}
    </div>
    {editing && !terminal && <div className="inline-editor"><label>Goal<input value={title} onChange={event => setTitle(event.target.value)}/></label><label>Next action<input value={next} onChange={event => setNext(event.target.value)} placeholder="Next action"/></label><label>New milestone<input value={milestoneTitle} onChange={event => setMilestoneTitle(event.target.value)} placeholder="Optional path step"/></label><button className="secondary" disabled={!milestoneTitle.trim()} onClick={() => { onChange({ ...goal, milestones: [...goal.milestones, { id: crypto.randomUUID(), title: milestoneTitle.trim(), done: false }] }); setMilestoneTitle('') }}>Add milestone</button><span>Where this leads</span><div className="link-options">{allGoals.filter(item => item.id !== goal.id && item.status !== 'closed').map(item => <label key={item.id}><input type="checkbox" checked={goal.links.includes(item.id)} onChange={event => onChange({ ...goal, links: event.target.checked ? [...goal.links, item.id] : goal.links.filter(id => id !== item.id) })}/>{item.title}</label>)}</div><button className="primary" disabled={!title.trim()} onClick={() => { onChange({ ...goal, title: title.trim(), nextAction: next.trim() || undefined }); setEditing(false) }}>Save</button></div>}
    {!terminal && <button className="deadline-link" onClick={onReview}>Review / close this goal <ChevronRight size={15}/></button>}
    <small className="evidence-count">{evidence.length} evidence item{evidence.length === 1 ? '' : 's'} connected · {goal.history.length} history event{goal.history.length === 1 ? '' : 's'}</small>
  </div>
}
function DeadlineReview({ goal, onBack, onSave }: { goal: Goal; onBack: () => void; onSave: (action: 'continue' | 'adjust' | 'close', reason: DeadlineReason, options?: { deadline?: string; target?: number; note?: string }) => void }) { const [reason, setReason] = useState<DeadlineReason>(); const [action, setAction] = useState<'continue' | 'adjust' | 'close'>(); const [deadline, setDeadline] = useState(deadlineFor(goal.horizon)); const [target, setTarget] = useState(goal.target?.toString() || ''); const [note, setNote] = useState(''); const targetValid = action !== 'adjust' || goal.kind !== 'numeric' || (target.trim() !== '' && Number.isFinite(Number(target))); const deadlineValid = action === 'close' || /^\d{4}-\d{2}-\d{2}$/.test(deadline); return <div className="sheet form-sheet"><button className="back" onClick={onBack}><ChevronLeft size={16}/> Goal</button><span className="label">DEADLINE REVIEW</span><h2>{goal.title}</h2><div className="result-row"><span>Target<b>{goal.target === undefined ? 'Not numeric' : formatValue(goal.target, goal.unit)}</b></span><span>Actual<b>{goal.current === undefined ? 'Not recorded' : formatValue(goal.current, goal.unit)}</b></span></div><p>What happened?</p><div className="reason-grid">{reasons.map(([value, label]) => <button aria-pressed={reason === value} className={reason === value ? 'selected' : ''} key={value} onClick={() => setReason(value)}>{label}</button>)}</div>{reason && <><div className="action-grid"><button aria-pressed={action === 'continue'} className={action === 'continue' ? 'selected' : ''} onClick={() => setAction('continue')}><b>Continue</b><small>Same goal, new deadline</small></button><button aria-pressed={action === 'adjust'} className={action === 'adjust' ? 'selected' : ''} onClick={() => setAction('adjust')}><b>Adjust</b><small>Change target or plan</small></button><button aria-pressed={action === 'close'} className={action === 'close' ? 'selected' : ''} onClick={() => setAction('close')}><b>Close</b><small>Accept and archive</small></button></div>{action && action !== 'close' && <label>New deadline<input type="date" value={deadline} onChange={event => setDeadline(event.target.value)}/></label>}{action === 'adjust' && goal.kind === 'numeric' && <label>New target<input inputMode="decimal" value={target} onChange={event => setTarget(event.target.value)}/></label>}<input aria-label="Optional review note" value={note} onChange={event => setNote(event.target.value)} placeholder="Optional note"/></>}<button className="primary wide" disabled={!reason || !action || !targetValid || !deadlineValid} onClick={() => reason && action && onSave(action, reason, { deadline: action === 'close' ? undefined : deadline, target: action === 'adjust' && goal.kind === 'numeric' ? Number(target) : undefined, note: note.trim() || undefined })}>Save review</button></div> }

function EvidenceGallery({ evidence, goals, selected, onSelect, onDelete }: { evidence: Evidence[]; goals: Goal[]; selected?: Evidence; onSelect: (id?: string) => void; onDelete: (item: Evidence) => void }) { const goalFor = (item: Evidence) => goals.find(goal => goal.id === item.goalId); const evidenceVisual = (item: Evidence, full = false) => item.kind === 'number' && item.value !== undefined ? <div className={full ? 'number-evidence full' : 'number-evidence'}><TrendingUp size={18}/><b>{formatValue(item.value, goalFor(item)?.unit)}</b></div> : item.kind === 'milestone' ? <div className={full ? 'number-evidence full' : 'number-evidence'}><Check size={18}/><b>{item.note || 'Milestone captured'}</b></div> : <MediaView mediaId={item.mediaId} full={full} defer={!full} alt={`${item.kind} evidence${goalFor(item) ? ` for ${goalFor(item)!.title}` : ''}`}/>; if (selected) return <div className="sheet evidence-full"><button className="back" onClick={() => onSelect(undefined)}><ChevronLeft size={16}/> Evidence</button>{evidenceVisual(selected, true)}<span className="label">{selected.kind.toUpperCase()}</span><h2>{goalFor(selected)?.title || 'Unlinked evidence'}</h2><p>{new Date(selected.capturedAt).toLocaleString()}{selected.note ? ` · ${selected.note}` : ''}</p><button className="danger-button" onClick={() => onDelete(selected)}><Trash2 size={15}/> Delete evidence</button></div>; return <div className="sheet"><span className="label">PRIVATE ON THIS DEVICE</span><h2>Evidence</h2>{evidence.length ? <div className="evidence-grid">{evidence.slice().reverse().map(item => <button key={item.id} onClick={() => onSelect(item.id)}>{evidenceVisual(item)}<span>{item.kind}</span><small>{new Date(item.capturedAt).toLocaleDateString()}</small></button>)}</div> : <p>No evidence yet. Add a photo, screenshot, number update, or milestone from Progress.</p>}</div> }
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
  const inPeriod = (timestamp: string) => { const date = localDateOf(timestamp); return date >= period.start && date <= period.end }
  const periodWins = data.wins.filter(win => inPeriod(win.createdAt))
  const featuredMedia = [...periodWins.flatMap(win => win.mediaId ? [{ id: win.id, mediaId: win.mediaId, alt: win.title }] : []), ...data.evidence.filter(item => inPeriod(item.capturedAt) && item.mediaId).map(item => ({ id: item.id, mediaId: item.mediaId!, alt: item.note || `${item.kind} evidence` }))][0]
  const moved = facts.goalMoves.done > 0 || facts.wins.length > 0 || facts.milestones.length > 0 || facts.completedGoals.length > 0 || facts.numeric.some(item => item.hasComparison && item.change !== 0)
  const cards: React.ReactNode[] = [
    <section className="story-card intro" key="intro"><span>{periodLabel(period).toUpperCase()}</span><h2>{moved ? 'You moved.' : 'An honest look.'}</h2><p>{formatDate(period.start)} — {formatDate(period.end)}</p></section>,
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

function AiPanel({ state, settings, selectedGoal, goals, onRun, onCancel, onAcceptAction, onAcceptTitle, onAcceptMilestone, onAcceptEvidence, onAcceptLink, onDismiss }: { state: { loading: boolean; action?: string; result?: AiPlan; error?: string }; settings: AppData['settings']['ai']; selectedGoal?: Goal; goals: Goal[]; onRun: () => void; onCancel: () => void; onAcceptAction: (action: string, goalId?: string) => void; onAcceptTitle: (title: string) => void; onAcceptMilestone: (title: string) => void; onAcceptEvidence: (suggestion: string) => boolean; onAcceptLink: (value: string) => boolean; onDismiss: () => void }) {
  const usage = applyMonthlyReset(settings)
  const [draft, setDraft] = useState<AiPlan>()
  const [copied, setCopied] = useState(false)
  const activeGoals = goals.filter(goal => goal.status === 'active')
  const [actionGoals, setActionGoals] = useState<string[]>([])
  const [showClarifiedGoal, setShowClarifiedGoal] = useState(true)
  useEffect(() => {
    setCopied(false)
    if (!state.result) { setDraft(undefined); setActionGoals([]); setShowClarifiedGoal(true); return }
    setDraft({ ...state.result, milestones: [...state.result.milestones], actions: [...state.result.actions], evidenceSuggestions: [...state.result.evidenceSuggestions], goalLinks: [...state.result.goalLinks] })
    setActionGoals(state.result.actions.map(() => selectedGoal?.status === 'active' ? selectedGoal.id : ''))
    setShowClarifiedGoal(true)
  }, [state.result, selectedGoal?.id])
  const setListItem = (key: 'actions' | 'milestones' | 'evidenceSuggestions' | 'goalLinks', index: number, value?: string) => setDraft(current => current ? { ...current, [key]: value === undefined ? current[key].filter((_, itemIndex) => itemIndex !== index) : current[key].map((item, itemIndex) => itemIndex === index ? value : item) } : current)
  const copyPerspective = async () => {
    if (!draft) return
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(draft.notes)
      else {
        const textarea = document.createElement('textarea')
        textarea.value = draft.notes
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.append(textarea)
        textarea.select()
        document.execCommand('copy')
        textarea.remove()
      }
      setCopied(true)
    } catch { setCopied(false) }
  }
  const capped = !canCallAi(usage)
  const heading = state.action === 'today' ? 'Suggest today’s moves' : state.action === 'week' ? 'Get perspective' : state.action === 'recap' ? 'Write recap summary' : `Plan ${selectedGoal?.title || 'this goal'}`
  return <div className="sheet ai-sheet"><span className="label">OPTIONAL AI</span><h2>{heading}</h2><p>Only the relevant goal or computed recap facts are sent. Images and the rest of your database stay on this device. Every proposed change waits for you.</p>{!state.result && !state.error && <><button className="primary wide" disabled={state.loading || !usage.enabled || capped} onClick={onRun}>{state.loading ? 'Thinking…' : !usage.enabled ? 'Enable AI in Settings first' : capped ? 'Monthly AI limit reached' : 'Generate suggestions'}</button>{state.loading && <button className="secondary wide" onClick={onCancel}>Cancel request</button>}</>}{state.error && <div className="error-box" role="alert">{state.error}{usage.enabled && !capped && <button onClick={onRun}>Try again</button>}</div>}{draft && <div className="ai-result">{selectedGoal && showClarifiedGoal && <div className="approval-item"><span>CLARIFIED GOAL</span><input aria-label="Edit clarified goal" value={draft.clarifiedGoal} onChange={event => setDraft({ ...draft, clarifiedGoal: event.target.value })}/><div><button disabled={!draft.clarifiedGoal.trim()} onClick={() => { onAcceptTitle(draft.clarifiedGoal); setShowClarifiedGoal(false) }}>Use wording</button><button onClick={() => setShowClarifiedGoal(false)}>Reject</button></div></div>}{draft.actions.length > 0 && <section><span>SUGGESTED GOAL MOVES</span>{draft.actions.slice(0, 3).map((action, index) => <div className="approval-item" key={`action:${index}`}><input aria-label={`Edit suggested move ${index + 1}`} value={action} onChange={event => setListItem('actions', index, event.target.value)}/><select aria-label={`Related goal for move ${index + 1}`} value={actionGoals[index] || ''} onChange={event => setActionGoals(values => values.map((value, itemIndex) => itemIndex === index ? event.target.value : value))}><option value="">Choose related goal</option>{activeGoals.map(goal => <option value={goal.id} key={goal.id}>{goal.title}</option>)}</select><div><button disabled={!action.trim() || !actionGoals[index]} onClick={() => { onAcceptAction(action, actionGoals[index]); setListItem('actions', index); setActionGoals(values => values.filter((_, itemIndex) => itemIndex !== index)) }}>Add</button><button onClick={() => { setListItem('actions', index); setActionGoals(values => values.filter((_, itemIndex) => itemIndex !== index)) }}>Reject</button></div></div>)}</section>}{selectedGoal && draft.milestones.length > 0 && <section><span>MILESTONES</span>{draft.milestones.map((item, index) => <ApprovalItem key={`milestone:${index}`} value={item} label={`Edit milestone ${index + 1}`} onChange={value => setListItem('milestones', index, value)} onAccept={() => { onAcceptMilestone(item); setListItem('milestones', index) }} onReject={() => setListItem('milestones', index)}/>)}</section>}{selectedGoal && draft.evidenceSuggestions.length > 0 && <section><span>EVIDENCE SCHEDULES</span>{draft.evidenceSuggestions.map((item, index) => <ApprovalItem key={`evidence:${index}`} value={item} label={`Edit evidence suggestion ${index + 1}`} onChange={value => setListItem('evidenceSuggestions', index, value)} onAccept={() => { if (onAcceptEvidence(item)) setListItem('evidenceSuggestions', index) }} onReject={() => setListItem('evidenceSuggestions', index)}/>)}</section>}{selectedGoal && draft.goalLinks.length > 0 && <section><span>POSSIBLE GOAL LINKS</span>{draft.goalLinks.map((item, index) => <ApprovalItem key={`link:${index}`} value={item} label={`Edit goal link ${index + 1}`} onChange={value => setListItem('goalLinks', index, value)} onAccept={() => { if (onAcceptLink(item)) setListItem('goalLinks', index) }} onReject={() => setListItem('goalLinks', index)}/>)}</section>}<label className="ai-notes">{state.action === 'week' || state.action === 'recap' ? 'EDITABLE PERSPECTIVE' : 'NOTES'}<textarea value={draft.notes} onChange={event => setDraft({ ...draft, notes: event.target.value })}/></label>{(state.action === 'week' || state.action === 'recap') && <button className="secondary wide" onClick={copyPerspective}>{copied ? 'Copied' : 'Copy perspective'}</button>}<button className="secondary wide" onClick={onDismiss}>Done</button></div>}<small>Estimated this month: ${usage.estimatedCost.toFixed(4)} of ${usage.monthlyCap.toFixed(2)} · {usage.requests} requests</small></div>
}

function ApprovalItem({ value, label, onChange, onAccept, onReject }: { value: string; label: string; onChange: (value: string) => void; onAccept: () => void; onReject: () => void }) { return <div className="approval-item"><input aria-label={label} value={value} onChange={event => onChange(event.target.value)}/><div><button disabled={!value.trim()} onClick={onAccept}>Add</button><button onClick={onReject}>Reject</button></div></div> }

function ProgressChart({ entries }: { entries: AppData['progress'] }) {
  if (!entries.length) return <div className="chart-empty"><TrendingUp size={18}/><span>No observations yet</span></div>
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
const periodLabel = (period: PeriodRecord) => period.kind === 'week' ? `Week ending ${formatDate(period.end)}` : period.kind === 'month' ? new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(new Date(`${period.start}T12:00:00`)) : period.kind === '3M' ? 'Three-month recap' : period.kind === '6M' ? 'Six-month recap' : `${period.start.slice(0, 4)} year recap`
const recurrenceLabel = (routine: Routine) => routine.recurrence.type === 'daily' ? 'Every day' : routine.recurrence.type === 'weekdays' ? 'Weekdays' : (routine.recurrence.weekdays || []).map(day => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][day]).join(', ')
function downloadJson(value: unknown, name: string) { const url = URL.createObjectURL(new Blob([JSON.stringify(value)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = name; link.rel = 'noopener'; document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1_000) }
