import { describe, expect, it } from 'vitest'
import type { AppData, Goal, MediaRecord } from './domain'
import { createBackup, restoreMedia, validateBackup } from './backup'
import { createInitialData } from './seed'

const at = '2026-09-14T12:00:00.000Z'

const media = (id: string, values: number[]): MediaRecord => ({
  id,
  blob: new Blob([new Uint8Array(values)], { type: 'image/jpeg' }),
  mimeType: 'image/jpeg',
  width: 120,
  height: 80,
  bytes: values.length,
  createdAt: at,
})

function richSnapshot(): AppData {
  const settings = createInitialData(new Date(at)).settings
  const goal: Goal = {
    id: 'qa-goal',
    title: 'QA goal',
    horizon: '1M',
    kind: 'numeric',
    area: 'Body',
    baseline: 140,
    current: 142,
    target: 150,
    direction: 'increase',
    unit: 'lbs',
    deadline: '2026-10-14',
    status: 'active',
    color: 'lime',
    milestones: [{ id: 'qa-milestone', title: 'First checkpoint', done: true, completedAt: at }],
    nextAction: 'Complete the next rep',
    links: ['linked-goal'],
    history: [
      { at, action: 'created', current: 140, target: 150, deadline: '2026-10-14' },
      { at: '2026-09-15T12:00:00.000Z', action: 'progressed', current: 142, target: 150 },
    ],
    evidenceSchedules: [{ id: 'qa-photo', kind: 'photo', cadence: 'monthly', lastCapturedAt: at, active: true }],
    createdAt: at,
  }
  const linkedGoal: Goal = {
    ...goal,
    id: 'linked-goal',
    title: 'Linked horizon',
    horizon: '3M',
    deadline: '2026-12-14',
    milestones: [],
    links: [],
    history: [{ at, action: 'created', deadline: '2026-12-14' }],
    evidenceSchedules: [],
  }
  return {
    schema: 2,
    goals: [goal, linkedGoal],
    routines: [{ id: 'qa-routine', title: 'Morning QA', section: 'Morning', recurrence: { type: 'weekdays-custom', weekdays: [1, 3, 5] }, active: true, goalId: goal.id, createdAt: at }],
    tasks: [
      { id: 'qa-task', title: 'Normal task', section: 'Day', done: true, kind: 'task', dueDate: '2026-09-14', createdAt: at, carriedCount: 0, status: 'active', resolvedAt: at },
      { id: 'qa-move', title: 'Goal Move', section: 'Moves That Matter', done: false, kind: 'move', goalId: goal.id, dueDate: '2026-09-14', createdAt: at, carriedCount: 0, status: 'active' },
      { id: 'qa-rolled', title: 'Carried work', section: 'Day', done: false, kind: 'task', dueDate: '2026-09-13', createdAt: at, carriedCount: 0, status: 'rolled', resolvedAt: at, rolledToId: 'qa-carried' },
      { id: 'qa-carried', title: 'Carried work', section: 'Day', done: false, kind: 'task', dueDate: '2026-09-14', createdAt: at, carriedCount: 1, status: 'active' },
    ],
    progress: [{ id: 'qa-progress', goalId: goal.id, value: 142, recordedAt: at, note: 'Measured' }],
    evidence: [
      { id: 'qa-photo-evidence', goalId: goal.id, scheduleId: 'qa-photo', kind: 'photo', capturedAt: at, note: 'Front view', mediaId: 'qa-photo-media' },
      { id: 'qa-number-evidence', goalId: goal.id, kind: 'number', capturedAt: at, note: 'Weekly measurement', value: 142 },
      { id: 'qa-milestone-evidence', goalId: goal.id, kind: 'milestone', capturedAt: at, milestoneId: 'qa-milestone' },
    ],
    wins: [{ id: 'qa-win', title: 'Finished the QA pass', note: 'Verified locally', goalId: goal.id, mediaId: 'qa-win-media', createdAt: at }],
    periods: [{ id: 'qa-period', kind: 'week', start: '2026-09-14', end: '2026-09-20', availableAt: '2026-09-21', finalized: false }],
    settings,
    onboarded: true,
    updatedAt: at,
  }
}

describe('release-candidate backup round trip', () => {
  it('round-trips every core entity, relationship, date, status, and media byte', async () => {
    const snapshot = richSnapshot()
    const photo = media('qa-photo-media', [1, 2, 3, 4])
    const win = media('qa-win-media', [9, 8, 7])
    const orphan = media('orphan-media', [5])

    const exported = await createBackup(snapshot, [photo, win, orphan], true)
    const parsed: unknown = JSON.parse(JSON.stringify(exported))
    expect(validateBackup(parsed)).toBe(true)
    if (!validateBackup(parsed)) throw new Error('Expected a valid backup')

    expect(parsed.media?.map(item => item.id).sort()).toEqual(['qa-photo-media', 'qa-win-media'])
    expect(parsed.data).toEqual(snapshot)
    expect(parsed.data.goals[0].links).toEqual(['linked-goal'])
    expect(parsed.data.tasks.find(task => task.id === 'qa-rolled')?.rolledToId).toBe('qa-carried')
    expect(parsed.data.evidence.find(item => item.scheduleId)?.goalId).toBe('qa-goal')
    expect(parsed.data.progress[0]).toMatchObject({ goalId: 'qa-goal', value: 142, recordedAt: at })
    expect(parsed.data.wins[0]).toMatchObject({ goalId: 'qa-goal', mediaId: 'qa-win-media' })

    const restored = await restoreMedia(parsed)
    expect(restored.map(item => item.id).sort()).toEqual(['qa-photo-media', 'qa-win-media'])
    expect([...new Uint8Array(await restored.find(item => item.id === 'qa-photo-media')!.blob.arrayBuffer())]).toEqual([1, 2, 3, 4])
    expect([...new Uint8Array(await restored.find(item => item.id === 'qa-win-media')!.blob.arrayBuffer())]).toEqual([9, 8, 7])
    expect(new Set(parsed.data.tasks.map(item => item.id)).size).toBe(parsed.data.tasks.length)
  })

  it('rejects invalid calendar dates and broken nested relationships', async () => {
    const valid = await createBackup(richSnapshot(), [], false)
    const goal = valid.data.goals[0]

    expect(validateBackup({ ...valid, data: { ...valid.data, tasks: valid.data.tasks.map((task, index) => index ? task : { ...task, dueDate: '2026-02-31' }) } })).toBe(false)
    expect(validateBackup({ ...valid, data: { ...valid.data, goals: [{ ...goal, milestones: [goal.milestones[0], goal.milestones[0]] }, ...valid.data.goals.slice(1)] } })).toBe(false)
    expect(validateBackup({ ...valid, data: { ...valid.data, evidence: valid.data.evidence.map((item, index) => index ? item : { ...item, scheduleId: 'missing-schedule' }) } })).toBe(false)
    expect(validateBackup({ ...valid, data: { ...valid.data, goals: [{ ...goal, links: [goal.id] }, ...valid.data.goals.slice(1)] } })).toBe(false)
    expect(validateBackup({ ...valid, data: { ...valid.data, tasks: valid.data.tasks.map(task => task.id === 'qa-rolled' ? { ...task, rolledToId: task.id } : task) } })).toBe(false)
  })

  it('round-trips one stored Blob shared by more than one relationship', async () => {
    const snapshot = richSnapshot()
    const sharedSnapshot = {
      ...snapshot,
      wins: snapshot.wins.map(win => ({ ...win, mediaId: 'qa-photo-media' })),
    }
    const photo = media('qa-photo-media', [1, 2, 3, 4])
    const exported = await createBackup(sharedSnapshot, [photo], true)

    expect(exported.media?.map(item => item.id)).toEqual(['qa-photo-media'])
    expect(exported.data.evidence[0].mediaId).toBe('qa-photo-media')
    expect(exported.data.wins[0].mediaId).toBe('qa-photo-media')
    expect(validateBackup(exported)).toBe(true)
    expect(await restoreMedia(exported)).toHaveLength(1)
  })

  it('rejects missing, duplicated, orphaned, or byte-mismatched media', async () => {
    const snapshot = richSnapshot()
    const photo = media('qa-photo-media', [1, 2, 3, 4])
    const win = media('qa-win-media', [9, 8, 7])

    await expect(createBackup(snapshot, [photo], true)).rejects.toThrow('missing from local storage')
    await expect(createBackup(snapshot, [photo, photo, win], true)).rejects.toThrow('Duplicate media')
    await expect(createBackup(snapshot, [{ ...photo, bytes: 99 }, win], true)).rejects.toThrow('size mismatch')

    const valid = await createBackup(snapshot, [photo, win], true)
    expect(validateBackup({ ...valid, media: [...valid.media!, { id: 'orphan', mimeType: 'image/jpeg', bytes: 1, createdAt: at, base64: 'AQ==' }] })).toBe(false)
    expect(validateBackup({ ...valid, media: valid.media!.map((item, index) => index ? item : { ...item, bytes: item.bytes + 1 }) })).toBe(false)
  })
})
