import { describe, expect, it, vi } from 'vitest'
import { createInitialData } from './seed'
import { nextEvidenceDueForSchedule } from './scheduler'
import { addMilestoneEvidenceToData, addProgressEvidenceToData, deleteEvidenceFromData, withAvailablePersistence } from './useMomentumApp'

const fixed = new Date(2026, 8, 14, 12)
const at = '2026-09-14T16:00:00.000Z'

describe('compound capture snapshot mutations', () => {
  it('rejects media persistence before starting an operation when storage is blocked', async () => {
    const operation = vi.fn(async () => undefined)

    await expect(withAvailablePersistence(true, operation)).rejects.toThrow('Local storage is unavailable')
    expect(operation).not.toHaveBeenCalled()
  })

  it('adds an observation and its companion photo to the same snapshot', () => {
    const source = createInitialData(fixed)
    const target = source.goals.find(goal => goal.id === 'seed-goal-1')!
    const progress = {
      id: 'observation',
      goalId: target.id,
      historyId: target.measurementHistoryId,
      value: 139,
      recordedAt: at,
      recordedOn: '2026-09-14',
    }
    const evidence = {
      id: 'evidence',
      goalId: target.id,
      goalIds: [target.id],
      kind: 'photo' as const,
      capturedAt: at,
      recordedOn: '2026-09-14',
      mediaId: 'media',
    }

    const result = addProgressEvidenceToData(source, progress, evidence)

    expect(result.progress).toContainEqual(expect.objectContaining({ id: progress.id, value: 139 }))
    expect(result.evidence).toContainEqual(expect.objectContaining({
      id: evidence.id,
      observationId: progress.id,
      historyId: target.measurementHistoryId,
      mediaId: 'media',
    }))
    expect(result.goals.find(goal => goal.id === target.id)?.current).toBe(139)
  })

  it('completes a planned milestone and records its photo in the same snapshot', () => {
    const initial = createInitialData(fixed)
    const goalId = 'seed-goal-3'
    const source = {
      ...initial,
      goals: initial.goals.map(goal => goal.id === goalId
        ? { ...goal, milestones: [{ id: 'launch', title: 'Launch', done: false }] }
        : goal),
    }
    const evidence = {
      id: 'milestone-evidence',
      goalId,
      goalIds: [goalId],
      kind: 'milestone' as const,
      capturedAt: at,
      recordedOn: '2026-09-14',
      mediaId: 'milestone-media',
    }

    const result = addMilestoneEvidenceToData(source, goalId, 'launch', at, evidence)
    const goal = result.goals.find(item => item.id === goalId)!

    expect(goal.milestones[0]).toMatchObject({ id: 'launch', done: true, completedAt: at })
    expect(goal.status).toBe('completed')
    expect(result.evidence).toContainEqual(expect.objectContaining({
      id: evidence.id,
      milestoneId: 'launch',
      mediaId: 'milestone-media',
    }))
  })

  it('clears only the deleted schedule cache and derives remaining cadence from recorded dates', () => {
    const initial = createInitialData(fixed)
    const goalId = 'seed-goal-1'
    const source = {
      ...initial,
      goals: initial.goals.map(goal => goal.id === goalId
        ? {
            ...goal,
            evidenceSchedules: [
              { id: 'photo-schedule', kind: 'photo' as const, cadence: 'monthly' as const, active: true, lastCapturedAt: '2026-09-30T16:00:00.000Z' },
              { id: 'note-schedule', kind: 'note' as const, cadence: 'weekly' as const, active: true, lastCapturedAt: '2026-09-12T16:00:00.000Z' },
            ],
          }
        : goal),
      evidence: [
        {
          id: 'older-by-capture-newer-by-record',
          goalId,
          goalIds: [goalId],
          scheduleId: 'photo-schedule',
          kind: 'photo' as const,
          capturedAt: '2026-09-01T16:00:00.000Z',
          recordedOn: '2026-09-10',
        },
        {
          id: 'deleted',
          goalId,
          goalIds: [goalId],
          scheduleId: 'photo-schedule',
          kind: 'photo' as const,
          capturedAt: '2026-09-30T16:00:00.000Z',
          recordedOn: '2026-09-02',
        },
      ],
    }

    const result = deleteEvidenceFromData(source, 'deleted')
    const schedules = result.goals.find(goal => goal.id === goalId)!.evidenceSchedules

    expect(schedules.find(schedule => schedule.id === 'photo-schedule')?.lastCapturedAt).toBeUndefined()
    expect(schedules.find(schedule => schedule.id === 'note-schedule')?.lastCapturedAt).toBe('2026-09-12T16:00:00.000Z')
    expect(result.evidence.map(item => item.id)).toEqual(['older-by-capture-newer-by-record'])
    expect(nextEvidenceDueForSchedule(result, goalId, 'photo-schedule')).toBe('2026-10-10')
  })
})
