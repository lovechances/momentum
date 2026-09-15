import type { AppData, Evidence } from './domain'
import { evidenceGoalIds, recordedDateOf } from './domain'

export function evidenceCaptureKey(item: Evidence) {
  if (item.observationId) return `observation:${item.observationId}`
  if (item.mediaId) return `media:${item.mediaId}`
  if (item.milestoneId) return `milestone:${item.milestoneId}`
  return `evidence:${item.id}`
}

function evidenceCaptureIdentities(item: Evidence) {
  return [
    item.observationId ? `observation:${item.observationId}` : undefined,
    item.mediaId ? `media:${item.mediaId}` : undefined,
    item.milestoneId ? `milestone:${item.milestoneId}` : undefined,
  ].filter((value): value is string => Boolean(value))
}

export function compareEvidenceCaptures(left: Evidence, right: Evidence) {
  return recordedDateOf(left).localeCompare(recordedDateOf(right))
    || left.capturedAt.localeCompare(right.capturedAt)
    || left.id.localeCompare(right.id)
}

const evidenceDisplayRank: Record<Evidence['kind'], number> = {
  milestone: 0,
  number: 1,
  note: 2,
  screenshot: 3,
  photo: 4,
}

/**
 * One logical capture can have multiple legacy rows when it was linked to
 * multiple goals. Keep every row for relationship/deletion semantics, use the
 * earliest row for chronology, and prefer richer evidence semantics for copy.
 */
export function evidenceCaptureGroups(data: Pick<AppData, 'evidence'>) {
  const parents = data.evidence.map((_, index) => index)
  const find = (index: number): number => parents[index] === index ? index : (parents[index] = find(parents[index]))
  const union = (left: number, right: number) => {
    const leftRoot = find(left)
    const rightRoot = find(right)
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot
  }
  const identityOwners = new Map<string, number>()
  data.evidence.forEach((item, index) => {
    for (const identity of evidenceCaptureIdentities(item)) {
      const owner = identityOwners.get(identity)
      if (owner === undefined) identityOwners.set(identity, index)
      else union(index, owner)
    }
  })

  const groups = new Map<number, Evidence[]>()
  data.evidence.forEach((item, index) => {
    const root = find(index)
    groups.set(root, [...(groups.get(root) ?? []), item])
  })
  return [...groups.values()].map(items => {
    const ordered = [...items].sort(compareEvidenceCaptures)
    const identities = items.flatMap(evidenceCaptureIdentities)
    const key = identities.find(value => value.startsWith('observation:'))
      ?? identities.find(value => value.startsWith('media:'))
      ?? identities.find(value => value.startsWith('milestone:'))
      ?? evidenceCaptureKey(ordered[0])
    const representative = [...items].sort((left, right) =>
      evidenceDisplayRank[left.kind] - evidenceDisplayRank[right.kind]
      || Number(Boolean(right.note?.trim())) - Number(Boolean(left.note?.trim()))
      || compareEvidenceCaptures(left, right))[0]
    return {
      key,
      items,
      canonical: ordered[0],
      representative,
      goalIds: [...new Set(items.flatMap(evidenceGoalIds))],
    }
  })
}
