import { describe, expect, it } from 'vitest'
import type { AppData, Evidence } from './domain'
import { evidenceCaptureGroups } from './recap'

describe('evidence capture grouping', () => {
  it('renders legacy relationship rows for one image as one rich capture', () => {
    const evidence: Evidence[] = [
      { id: 'photo-row', goalId: 'body', historyId: 'weight', kind: 'photo', mediaId: 'local-image', capturedAt: '2026-09-08T12:00:00.000Z', recordedOn: '2026-09-08' },
      { id: 'milestone-row', goalId: 'business', kind: 'milestone', milestoneId: 'launch', mediaId: 'local-image', note: 'Launch shipped', capturedAt: '2026-09-09T12:00:00.000Z', recordedOn: '2026-09-09' },
    ]

    const groups = evidenceCaptureGroups({ evidence })

    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({
      key: 'media:local-image',
      canonical: { id: 'photo-row' },
      representative: { id: 'milestone-row', kind: 'milestone', note: 'Launch shipped' },
      goalIds: ['body', 'business'],
    })
    expect(groups[0].items.map(item => item.id)).toEqual(['photo-row', 'milestone-row'])
  })

  it('never treats reminder schedule definitions as captured evidence', () => {
    const data = {
      evidence: [],
      goals: [{ evidenceSchedules: [{ id: 'weekly-photo', kind: 'photo', cadence: 'weekly', active: true }] }],
    } as unknown as AppData

    expect(evidenceCaptureGroups(data)).toEqual([])
  })

  it('keeps a numeric observation and its later photo attachment as one event', () => {
    const evidence: Evidence[] = [
      { id: 'number-row', goalId: 'body', observationId: 'weigh-in', kind: 'number', value: 145, capturedAt: '2026-09-08T12:00:00.000Z', recordedOn: '2026-09-08' },
      { id: 'photo-row', goalId: 'body', observationId: 'weigh-in', kind: 'photo', mediaId: 'attachment', capturedAt: '2026-09-09T12:00:00.000Z', recordedOn: '2026-09-09' },
    ]

    const groups = evidenceCaptureGroups({ evidence })

    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({
      key: 'observation:weigh-in',
      canonical: { id: 'number-row' },
      representative: { id: 'number-row', kind: 'number' },
    })
    expect(groups[0].items.map(item => item.id)).toEqual(['number-row', 'photo-row'])
  })

  it('transitively merges milestone and media relationship rows', () => {
    const evidence: Evidence[] = [
      { id: 'milestone-note', goalId: 'launch', milestoneId: 'shipped', kind: 'milestone', note: 'Shipped', capturedAt: '2026-09-08T12:00:00.000Z' },
      { id: 'milestone-photo', goalId: 'launch', milestoneId: 'shipped', kind: 'photo', mediaId: 'receipt', capturedAt: '2026-09-08T12:00:01.000Z' },
      { id: 'legacy-goal-copy', goalId: 'revenue', kind: 'photo', mediaId: 'receipt', capturedAt: '2026-09-08T12:00:02.000Z' },
    ]

    const groups = evidenceCaptureGroups({ evidence })

    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({
      key: 'media:receipt',
      representative: { id: 'milestone-note', kind: 'milestone' },
      goalIds: ['launch', 'revenue'],
    })
    expect(groups[0].items).toHaveLength(3)
  })
})
