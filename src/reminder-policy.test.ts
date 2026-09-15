import { describe, expect, it } from 'vitest'
import type { AppData, Goal, MediaRecord, Task } from './domain'
import { evidenceGoalIds } from './domain'
import { createBackup, validateBackup } from './backup'
import { defaultEvidenceSchedulesForGoal } from './goals'
import { migrateSnapshot } from './migrations'
import {
  dueEvidence,
  evidencePromptWindow,
  evidenceTrackKey,
  reconcileEvidenceReminderPolicy,
  reconcileSchedule,
  satisfyProgressReminderOccurrences,
  satisfyReminderOccurrences,
} from './scheduler'
import { createInitialData } from './seed'

const date = '2026-09-15'
const at = `${date}T12:00:00.000Z`
const fixed = new Date(at)

function goal(id: string, title: string, patch: Partial<Goal> = {}): Goal {
  return {
    id,
    title,
    horizon: '1M',
    kind: 'qualitative',
    deadline: '2026-10-01',
    deadlineAnchor: '2026-09-01',
    deadlineProvenance: 'calendar-default',
    status: 'active',
    color: 'sky',
    milestones: [],
    links: [],
    history: [{ at, action: 'created', deadline: '2026-10-01' }],
    evidenceSchedules: [],
    createdAt: at,
    ...patch,
  }
}

function task(id: string, goalId: string, patch: Partial<Task> = {}): Task {
  return {
    id,
    title: `Work on ${goalId}`,
    section: 'Moves That Matter',
    done: false,
    kind: 'move',
    goalId,
    dueDate: date,
    createdAt: at,
    carriedCount: 0,
    status: 'active',
    ...patch,
  }
}

function snapshot(patch: Partial<AppData>): AppData {
  return { ...createInitialData(fixed), goals: [], routines: [], tasks: [], measurementHistories: [], reminderOccurrences: [], ...patch }
}

function legacyAuto(goalId: string, kind: 'note' | 'number' = 'note') {
  return {
    id: `${goalId}-${kind}-weekly`,
    kind,
    cadence: 'weekly' as const,
    firstDueDate: date,
    active: true,
  }
}

describe('evidence reminder noise policy', () => {
  it('uses one logical weekly cadence for linked Weight and Savings histories', () => {
    const weightHistory = { id: 'weight', label: 'Weight', unit: 'lbs', semanticKey: 'body-weight' as const, createdAt: at }
    const savingsHistory = { id: 'savings', label: 'Savings', unit: 'USD', semanticKey: 'savings-balance' as const, createdAt: at }
    const weights = ['140', '150', '170', '175-185'].map((target, index) => {
      const value = goal(`weight-${index}`, `${target} lbs`, {
        horizon: index ? '1Y' : '1M', kind: 'numeric', unit: 'lbs', target: Number.parseInt(target), measurementHistoryId: weightHistory.id,
      })
      return { ...value, evidenceSchedules: defaultEvidenceSchedulesForGoal(value, weightHistory.id, weightHistory.semanticKey).map(({ provenance: _provenance, ...schedule }) => schedule) }
    })
    const savings = ['7', '10', '20'].map((target, index) => {
      const value = goal(`savings-${index}`, `$${target}k stacked`, {
        horizon: index ? '6M' : '1M', kind: 'numeric', unit: 'USD', target: Number(target) * 1_000, measurementHistoryId: savingsHistory.id,
      })
      return { ...value, evidenceSchedules: defaultEvidenceSchedulesForGoal(value, savingsHistory.id, savingsHistory.semanticKey).map(({ provenance: _provenance, ...schedule }) => schedule) }
    })
    const reconciled = reconcileEvidenceReminderPolicy(snapshot({ goals: [...weights, ...savings], measurementHistories: [weightHistory, savingsHistory] }), date)
    const due = dueEvidence(reconciled.goals, [], date)
    expect(due.filter(item => item.schedule.historyId === weightHistory.id && item.schedule.kind === 'number')).toHaveLength(1)
    expect(due.filter(item => item.schedule.historyId === weightHistory.id && item.schedule.kind === 'photo')).toHaveLength(1)
    expect(due.filter(item => item.schedule.historyId === savingsHistory.id && item.schedule.kind === 'number')).toHaveLength(1)
    expect(due.filter(item => item.schedule.historyId === savingsHistory.id && item.schedule.kind === 'screenshot')).toHaveLength(0)
    expect(new Set(reconciled.goals.slice(0, 4).flatMap(item => item.evidenceSchedules.filter(schedule => schedule.kind === 'number').map(schedule => evidenceTrackKey({ goal: item, schedule })))).size).toBe(1)
  })

  it('allows a recent 1M execution goal and retires broad long-horizon defaults', () => {
    const current = goal('buyee', 'Finish Buyee')
    const longTerm = [
      goal('location', 'Location freedom', { horizon: '2Y', evidenceSchedules: [legacyAuto('location')] }),
      goal('brand', 'Personal brand reputable', { horizon: '2Y', evidenceSchedules: [legacyAuto('brand')] }),
      goal('income', '$5k/mo online', { horizon: '1Y', kind: 'numeric', unit: 'USD', measurementHistoryId: 'income-history', evidenceSchedules: [{ ...legacyAuto('income', 'number'), historyId: 'income-history' }] }),
    ]
    const reconciled = reconcileEvidenceReminderPolicy(snapshot({ goals: [current, ...longTerm], tasks: [task('ship', current.id)] }), date)
    expect(reconciled.goals[0].evidenceSchedules).toMatchObject([{ kind: 'note', cadence: 'weekly', active: true, provenance: 'auto-default' }])
    expect(reconciled.goals.slice(1).flatMap(item => item.evidenceSchedules).every(item => !item.active)).toBe(true)
    expect(dueEvidence(reconciled.goals, [], date).map(item => item.goal.id)).toEqual(['buyee'])
  })

  it('preserves manual and identifiable customized reminders on long-term goals', () => {
    const manual = goal('location', 'Location freedom', {
      horizon: '2Y',
      evidenceSchedules: [{ id: 'e335b643-f88f-4b8c-ae3a-864ef26d342c', kind: 'note', cadence: 'weekly', firstDueDate: date, active: true }],
    })
    const customized = goal('brand', 'Personal brand reputable', {
      horizon: '2Y',
      evidenceSchedules: [{ id: 'brand-note-weekly', kind: 'note', cadence: 'monthly', firstDueDate: date, active: true }],
    })
    const reconciled = reconcileEvidenceReminderPolicy(snapshot({ goals: [manual, customized] }), date)
    expect(reconciled.goals.flatMap(item => item.evidenceSchedules)).toMatchObject([
      { id: manual.evidenceSchedules[0].id, active: true, provenance: 'legacy-unknown' },
      { id: customized.evidenceSchedules[0].id, cadence: 'monthly', active: true, provenance: 'legacy-unknown' },
    ])
  })

  it('cleans the deployed flood idempotently without deleting data or handled history', async () => {
    const base = createInitialData(fixed)
    const baseNoisy = base.goals.find(item => item.title === 'Location freedom')!
    const noisy = { ...baseNoisy, evidenceSchedules: [legacyAuto(baseNoisy.id)] }
    const trackId = evidenceTrackKey({ goal: noisy, schedule: noisy.evidenceSchedules[0] })
    const dueId = `evidence:${trackId}:${date}`
    const evidence = [{ id: 'receipt', goalId: noisy.id, goalIds: [noisy.id], scheduleId: noisy.evidenceSchedules[0].id, kind: 'screenshot' as const, capturedAt: at, recordedOn: date, mediaId: 'media' }]
    const weight = base.goals.find(item => item.unit === 'lbs')!
    const source: AppData = {
      ...base,
      goals: base.goals.map(item => item.id === noisy.id ? noisy : item),
      tasks: [task('unrelated', noisy.id)], evidence,
      progress: [{ id: 'progress', goalId: weight.id, historyId: weight.measurementHistoryId, value: 141, recordedAt: at, recordedOn: date }],
      reminderOccurrences: [
        { id: dueId, trackId, scheduleId: noisy.evidenceSchedules[0].id, dueDate: date, status: 'due' },
        { id: `${dueId}:old`, trackId, scheduleId: noisy.evidenceSchedules[0].id, dueDate: '2026-09-08', status: 'satisfied', handledAt: at, satisfiedByEntryId: 'receipt' },
      ],
      settings: { ...base.settings, ai: { enabled: true, monthlyCap: 1, month: '2026-09', estimatedCost: 0.02, inputTokens: 10, outputTokens: 4, requests: 1 } },
    }
    const reconciled = reconcileEvidenceReminderPolicy(source, date)
    expect(reconciled.goals.find(item => item.id === noisy.id)?.evidenceSchedules[0]).toMatchObject({ active: false, provenance: 'auto-default' })
    expect(reconciled.reminderOccurrences).toMatchObject([{ status: 'satisfied', satisfiedByEntryId: 'receipt' }])
    expect(reconciled.evidence).toEqual(source.evidence)
    expect(reconciled.tasks).toEqual(source.tasks)
    expect(reconciled.progress).toEqual(source.progress)
    expect(reconciled.measurementHistories).toEqual(source.measurementHistories)
    expect(reconciled.settings.ai).toEqual(source.settings.ai)
    expect(reconcileEvidenceReminderPolicy(reconciled, date)).toBe(reconciled)
    expect(dueEvidence(reconciled.goals, reconciled.evidence, date, reconciled.reminderOccurrences).some(item => item.goal.id === noisy.id)).toBe(false)

    const media: MediaRecord = { id: 'media', blob: new Blob([new Uint8Array([1, 2])], { type: 'image/png' }), mimeType: 'image/png', bytes: 2, createdAt: at }
    expect(validateBackup(await createBackup(reconciled, [media], true))).toBe(true)
  })

  it('applies the cleanup during migration and never recreates a retired default', () => {
    const noisy = goal('location', 'Location freedom', { horizon: '2Y', evidenceSchedules: [legacyAuto('location')] })
    const first = migrateSnapshot(snapshot({ goals: [noisy] }), fixed)
    const second = migrateSnapshot(first, fixed)
    expect(first.goals[0].evidenceSchedules[0]).toMatchObject({ active: false, provenance: 'auto-default' })
    expect(second).toEqual(first)
    expect(second.goals[0].evidenceSchedules).toHaveLength(1)
  })

  it('lets one shared capture satisfy one shared cadence while retaining multi-goal evidence links', () => {
    const first = goal('launch', 'Launch business', { evidenceSchedules: [{ id: 'manual-launch', kind: 'note', cadence: 'weekly', active: true, provenance: 'manual' }] })
    const broader = goal('income', 'Online income', { horizon: '1Y' })
    const source = snapshot({ goals: [first, broader] })
    const scheduled = reconcileSchedule(source, date)
    const capture = { id: 'capture', goalId: first.id, goalIds: [first.id, broader.id], scheduleId: 'manual-launch', kind: 'screenshot' as const, capturedAt: at, recordedOn: date, mediaId: 'image' }
    const occurrences = satisfyReminderOccurrences({ ...source, evidence: [capture], reminderOccurrences: scheduled.reminderOccurrences }, capture)
    expect(occurrences.filter(item => item.status === 'satisfied')).toHaveLength(1)
    expect(evidenceGoalIds(capture)).toEqual([first.id, broader.id])
    expect(broader.evidenceSchedules).toEqual([])
  })

  it('lets one observation satisfy the single shared number occurrence', () => {
    const history = { id: 'weight', label: 'Weight', unit: 'lbs', semanticKey: 'body-weight' as const, createdAt: at }
    const goals = ['140', '150', '170', '180'].map((title, index) => {
      const value = goal(`weight-${index}`, title, { kind: 'numeric', unit: 'lbs', measurementHistoryId: history.id })
      return { ...value, evidenceSchedules: defaultEvidenceSchedulesForGoal(value, history.id, history.semanticKey).filter(item => item.kind === 'number') }
    })
    const source = snapshot({ goals, measurementHistories: [history] })
    const scheduled = reconcileSchedule(source, date)
    expect(scheduled.reminderOccurrences).toHaveLength(1)
    const observation = { id: 'weight-entry', goalId: goals[0].id, historyId: history.id, value: 145, recordedAt: at, recordedOn: date }
    expect(satisfyProgressReminderOccurrences({ ...source, reminderOccurrences: scheduled.reminderOccurrences }, observation)).toMatchObject([{ status: 'satisfied', satisfiedByEntryId: observation.id }])
  })

  it('caps rendered evidence prompts at three without changing deadline or recap reminders', () => {
    expect(evidencePromptWindow([1, 2, 3, 4, 5])).toEqual({ visible: [1, 2, 3], hiddenCount: 2 })
    const longTerm = goal('location', 'Location freedom', { horizon: '2Y', deadline: date, evidenceSchedules: [legacyAuto('location')] })
    const source = snapshot({
      goals: [longTerm],
      tasks: [{ ...task('prior', longTerm.id), done: true, dueDate: '2026-09-08' }],
      planning: { anchorMonth: '2026-09-01', trackingStartedOn: '2026-09-01' },
    })
    const before = reconcileSchedule(source, date).reminders.filter(item => item.kind !== 'evidence')
    const after = reconcileSchedule(reconcileEvidenceReminderPolicy(source, date), date).reminders.filter(item => item.kind !== 'evidence')
    expect(after).toEqual(before)
    expect(after.some(item => item.kind === 'deadline')).toBe(true)
  })
})
