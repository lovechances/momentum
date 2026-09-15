export type Horizon = '1M' | '3M' | '6M' | '1Y' | '2Y'
export type GoalStatus = 'active' | 'paused' | 'completed' | 'closed'
export type GoalKind = 'numeric' | 'binary' | 'milestone' | 'consistency' | 'qualitative'
export type TaskKind = 'task' | 'routine' | 'move'
export type Section = 'Morning' | 'Moves That Matter' | 'Day' | 'Evening'
export type EvidenceKind = 'photo' | 'screenshot' | 'number' | 'milestone'
export type EvidenceCadence = 'weekly' | 'monthly' | 'quarterly'
export type GoalDirection = 'increase' | 'decrease'
export type TaskStatus = 'active' | 'rolled' | 'dropped'

export interface Goal { id:string; title:string; horizon:Horizon; kind:GoalKind; area?:string; baseline?:number; current?:number; target?:number; direction?:GoalDirection; unit?:string; deadline:string; status:GoalStatus; color:string; milestones:Milestone[]; nextAction?:string; links:string[]; history:GoalAttempt[]; evidenceSchedules:EvidenceSchedule[]; createdAt:string }
export interface Milestone { id:string; title:string; done:boolean; completedAt?:string }
export interface GoalAttempt { at:string; action:'created'|'continued'|'adjusted'|'closed'|'completed'|'progressed'|'paused'|'resumed'|'reopened'|'milestone'; note?:string; current?:number; target?:number; deadline?:string }
export interface Task { id:string; title:string; section:Section; done:boolean; kind:TaskKind; goalId?:string; dueDate:string; sourceRoutineId?:string; createdAt:string; carriedCount:number; lightDay?:boolean; status?:TaskStatus; resolvedAt?:string; rolledToId?:string }
export interface Routine { id:string; title:string; section:Section; recurrence:{ type:'daily'|'weekdays'|'weekdays-custom'; weekdays?:number[] }; active:boolean; goalId?:string; createdAt:string }
export interface EvidenceSchedule { id:string; kind:EvidenceKind; cadence:EvidenceCadence; lastCapturedAt?:string; firstDueDate?:string; active:boolean }
export interface Evidence { id:string; goalId?:string; scheduleId?:string; kind:EvidenceKind; capturedAt:string; note?:string; mediaId?:string; value?:number; milestoneId?:string }
export interface MediaRecord { id:string; blob:Blob; mimeType:string; width?:number; height?:number; bytes:number; createdAt:string }
export interface Win { id:string; title:string; note?:string; goalId?:string; mediaId?:string; createdAt:string }
export interface ProgressEntry { id:string; goalId:string; value:number; recordedAt:string; note?:string }
export interface PeriodRecord { id:string; kind:'week'|'month'|'3M'|'6M'|'year'; start:string; end:string; availableAt:string; finalized:boolean }
export interface Reminder { id:string; kind:'morning'|'evidence'|'recap'|'deadline'|'planning'|'rollover'; title:string; detail?:string; dueDate:string; action?:string }
export interface AppData { schema:2; goals:Goal[]; tasks:Task[]; routines:Routine[]; evidence:Evidence[]; wins:Win[]; progress:ProgressEntry[]; periods:PeriodRecord[]; settings:Settings; onboarded:boolean; updatedAt:string }
export interface Settings { areas:string[]; ai:{ enabled:boolean; monthlyCap:number; month:string; estimatedCost:number; inputTokens:number; outputTokens:number; requests:number }; reminders:{morning:boolean;evidence:boolean;recap:boolean;deadline:boolean} }

export const todayLocal = (date=new Date()) => { const offset=date.getTimezoneOffset()*60000; return new Date(date.getTime()-offset).toISOString().slice(0,10) }
export const localDateOf = (value:string|Date) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  ? value
  : todayLocal(value instanceof Date ? value : new Date(value))
export const now = () => new Date().toISOString()
