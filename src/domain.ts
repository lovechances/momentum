export type Horizon = '1M' | '3M' | '6M' | '1Y' | '2Y'
export type GoalStatus = 'active' | 'paused' | 'completed' | 'closed'
export type GoalKind = 'numeric' | 'binary' | 'milestone' | 'consistency' | 'qualitative'
export type TaskKind = 'task' | 'routine' | 'move'
export type Section = 'Morning' | 'Moves That Matter' | 'Day' | 'Evening'
export type EvidenceKind = 'photo' | 'screenshot' | 'number' | 'milestone' | 'note'
export type EvidenceCadence = 'weekly' | 'monthly' | 'quarterly'
export type GoalDirection = 'increase' | 'decrease'
export type TaskStatus = 'active' | 'rolled' | 'dropped' | 'excluded' | 'deleted'
export type DeadlineProvenance = 'calendar-default' | 'manual' | 'legacy-unknown'

export interface Goal {
  id:string; title:string; horizon:Horizon; kind:GoalKind; area?:string
  baseline?:number; current?:number; target?:number; direction?:GoalDirection; unit?:string
  deadline:string; deadlineAnchor?:string; deadlineProvenance?:DeadlineProvenance
  measurementHistoryId?:string
  contextNotes?:string[]
  status:GoalStatus; color:string; milestones:Milestone[]; nextAction?:string; links:string[]
  history:GoalAttempt[]; evidenceSchedules:EvidenceSchedule[]; createdAt:string
}
export interface Milestone { id:string; title:string; done:boolean; completedAt?:string }
export interface GoalAttempt { at:string; action:'created'|'continued'|'adjusted'|'closed'|'completed'|'progressed'|'paused'|'resumed'|'reopened'|'milestone'; note?:string; current?:number; target?:number; deadline?:string }
export interface TaskEvent { at:string; action:'edited'|'deleted'|'restored'|'excluded'|'completed'|'reopened'; title?:string; details?:string; section?:Section; dueDate?:string; kind?:TaskKind; goalId?:string }
export interface Task { id:string; title:string; details?:string; section:Section; done:boolean; kind:TaskKind; goalId?:string; dueDate:string; sourceRoutineId?:string; createdAt:string; carriedCount:number; lightDay?:boolean; status?:TaskStatus; resolvedAt?:string; rolledToId?:string; history?:TaskEvent[] }
export interface Routine { id:string; title:string; section:Section; recurrence:{ type:'daily'|'weekdays'|'weekdays-custom'; weekdays?:number[] }; active:boolean; goalId?:string; createdAt:string; stoppedAt?:string }
export interface EvidenceSchedule { id:string; kind:EvidenceKind; cadence:EvidenceCadence; historyId?:string; lastCapturedAt?:string; firstDueDate?:string; active:boolean }
export interface Evidence { id:string; goalId?:string; goalIds?:string[]; historyId?:string; observationId?:string; scheduleId?:string; kind:EvidenceKind; capturedAt:string; recordedOn?:string; note?:string; mediaId?:string; value?:number; milestoneId?:string }
export interface MediaRecord { id:string; blob:Blob; mimeType:string; width?:number; height?:number; bytes:number; createdAt:string }
export interface Win { id:string; title:string; note?:string; goalId?:string; goalIds?:string[]; mediaId?:string; createdAt:string; recordedOn?:string }
export interface ProgressEntry { id:string; goalId:string; historyId?:string; value:number; recordedAt:string; recordedOn?:string; note?:string }
export interface MeasurementHistory { id:string; label:string; unit?:string; semanticKey?:'body-weight'|'savings-balance'; scopeKey?:string; createdAt:string; mergedIntoId?:string }
export interface ProgressLinkSuggestion { id:string; label:string; goalIds:string[]; historyIds:string[]; status:'pending'|'confirmed'|'dismissed'; createdAt:string }
export interface RoutineExclusion { id:string; routineId:string; date:string; createdAt:string }
export interface ReminderOccurrence { id:string; trackId:string; scheduleId:string; dueDate:string; status:'due'|'snoozed'|'skipped'|'satisfied'; snoozedUntil?:string; handledAt?:string; satisfiedByEntryId?:string }
export interface PlanningState { anchorMonth:string; trackingStartedOn:string }
export interface PeriodRecord { id:string; kind:'week'|'month'|'3M'|'6M'|'year'; start:string; end:string; availableAt:string; finalized:boolean; anchorMonth?:string; effectiveStart?:string }
export interface Reminder { id:string; kind:'morning'|'evidence'|'recap'|'deadline'|'planning'|'rollover'; title:string; detail?:string; dueDate:string; action?:string }
export interface AppData { schema:3; goals:Goal[]; tasks:Task[]; routines:Routine[]; evidence:Evidence[]; wins:Win[]; progress:ProgressEntry[]; measurementHistories:MeasurementHistory[]; progressLinkSuggestions:ProgressLinkSuggestion[]; routineExclusions:RoutineExclusion[]; reminderOccurrences:ReminderOccurrence[]; planning:PlanningState; periods:PeriodRecord[]; settings:Settings; onboarded:boolean; updatedAt:string }
export interface Settings { areas:string[]; ai:{ enabled:boolean; monthlyCap:number; month:string; estimatedCost:number; inputTokens:number; outputTokens:number; requests:number }; reminders:{morning:boolean;evidence:boolean;recap:boolean;deadline:boolean} }

export const todayLocal = (date=new Date()) => { const offset=date.getTimezoneOffset()*60000; return new Date(date.getTime()-offset).toISOString().slice(0,10) }
export const localDateOf = (value:string|Date) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  ? value
  : todayLocal(value instanceof Date ? value : new Date(value))
export const now = () => new Date().toISOString()
export const recordedDateOf = (value: { recordedOn?: string; recordedAt?: string; capturedAt?: string; createdAt?: string }) =>
  value.recordedOn ?? localDateOf(value.recordedAt ?? value.capturedAt ?? value.createdAt ?? now())
export const timestampForLocalDate = (date: string, fallback = now()) =>
  localDateOf(fallback) === date ? fallback : new Date(`${date}T12:00:00`).toISOString()
export const compareProgressEntries = (left: ProgressEntry, right: ProgressEntry) =>
  recordedDateOf(left).localeCompare(recordedDateOf(right))
  || left.recordedAt.localeCompare(right.recordedAt)
  || left.id.localeCompare(right.id)
export const evidenceGoalIds = (value: Pick<Evidence | Win, 'goalId' | 'goalIds'>) =>
  [...new Set([...(value.goalIds ?? []), ...(value.goalId ? [value.goalId] : [])])]
