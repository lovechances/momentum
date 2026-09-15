import type { AppData, Goal, MediaRecord } from './domain'
import { migrateSnapshot } from './migrations'

export type BackupMedia = {
  id: string
  mimeType: string
  bytes: number
  width?: number
  height?: number
  createdAt: string
  base64: string
}
export type Backup = { schema: 3; exportedAt: string; data: AppData; media?: BackupMedia[] }

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string'
const nonEmpty = (value: unknown): value is string => text(value) && value.length > 0
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const optionalFinite = (value: unknown) => value === undefined || finite(value)
const nonnegativeSafeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const positiveSafeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const timestamp = (value: unknown): value is string => nonEmpty(value) && Number.isFinite(Date.parse(value))
const localDate = (value: unknown): value is string => {
  if (!text(value) || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}
const oneOf = <T extends string>(value: unknown, values: readonly T[]): value is T => text(value) && values.includes(value as T)
const uniqueIds = (values: { id: string }[]) => new Set(values.map(value => value.id)).size === values.length

const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const mediaMimeTypes = new Set(['image/jpeg', 'image/jpg', 'image/pjpeg', 'image/png', 'image/webp', 'image/avif', 'image/heic', 'image/heif'])

function decodedBase64Bytes(value: string) {
  if (!base64Pattern.test(value)) return undefined
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return (value.length / 4) * 3 - padding
}

function validHistory(value: unknown) {
  const actions = ['created', 'continued', 'adjusted', 'closed', 'completed', 'progressed', 'paused', 'resumed', 'reopened', 'milestone'] as const
  return Array.isArray(value) && value.every(item => record(item)
    && timestamp(item.at)
    && oneOf(item.action, actions)
    && (item.note === undefined || text(item.note))
    && optionalFinite(item.current)
    && optionalFinite(item.target)
    && (item.deadline === undefined || localDate(item.deadline)))
}

function validGoal(value: unknown) {
  if (!record(value)) return false
  const horizons = ['1M', '3M', '6M', '1Y', '2Y'] as const
  const kinds = ['numeric', 'binary', 'milestone', 'consistency', 'qualitative'] as const
  const statuses = ['active', 'paused', 'completed', 'closed'] as const
  const evidenceKinds = ['photo', 'screenshot', 'number', 'milestone', 'note'] as const
  const cadences = ['weekly', 'monthly', 'quarterly'] as const
  return nonEmpty(value.id)
    && nonEmpty(value.title)
    && oneOf(value.horizon, horizons)
    && oneOf(value.kind, kinds)
    && (value.area === undefined || text(value.area))
    && optionalFinite(value.baseline)
    && optionalFinite(value.current)
    && optionalFinite(value.target)
    && (value.direction === undefined || oneOf(value.direction, ['increase', 'decrease'] as const))
    && (value.unit === undefined || text(value.unit))
    && localDate(value.deadline)
    && oneOf(value.status, statuses)
    && text(value.color)
    && Array.isArray(value.milestones)
    && value.milestones.every(item => record(item)
      && nonEmpty(item.id)
      && nonEmpty(item.title)
      && typeof item.done === 'boolean'
      && (item.completedAt === undefined || timestamp(item.completedAt)))
    && uniqueIds(value.milestones as { id: string }[])
    && (value.nextAction === undefined || text(value.nextAction))
    && Array.isArray(value.links)
    && value.links.every(text)
    && validHistory(value.history)
    && Array.isArray(value.evidenceSchedules)
    && value.evidenceSchedules.every(item => record(item)
      && nonEmpty(item.id)
      && oneOf(item.kind, evidenceKinds)
      && oneOf(item.cadence, cadences)
      && (item.lastCapturedAt === undefined || timestamp(item.lastCapturedAt))
      && (item.firstDueDate === undefined || localDate(item.firstDueDate))
      && typeof item.active === 'boolean')
    && uniqueIds(value.evidenceSchedules as { id: string }[])
    && timestamp(value.createdAt)
}

function validTask(value: unknown) {
  if (!record(value)) return false
  return nonEmpty(value.id)
    && nonEmpty(value.title)
    && (value.details === undefined || text(value.details))
    && oneOf(value.section, ['Morning', 'Moves That Matter', 'Day', 'Evening'] as const)
    && typeof value.done === 'boolean'
    && oneOf(value.kind, ['task', 'routine', 'move'] as const)
    && (value.goalId === undefined || nonEmpty(value.goalId))
    && localDate(value.dueDate)
    && (value.sourceRoutineId === undefined || nonEmpty(value.sourceRoutineId))
    && timestamp(value.createdAt)
    && nonnegativeSafeInteger(value.carriedCount)
    && (value.lightDay === undefined || typeof value.lightDay === 'boolean')
    && (value.status === undefined || oneOf(value.status, ['active', 'rolled', 'dropped', 'excluded', 'deleted'] as const))
    && (value.resolvedAt === undefined || timestamp(value.resolvedAt))
    && (value.rolledToId === undefined || nonEmpty(value.rolledToId))
}

function validRoutine(value: unknown) {
  if (!record(value) || !record(value.recurrence)) return false
  const recurrenceType = value.recurrence.type
  return nonEmpty(value.id)
    && nonEmpty(value.title)
    && oneOf(value.section, ['Morning', 'Moves That Matter', 'Day', 'Evening'] as const)
    && oneOf(recurrenceType, ['daily', 'weekdays', 'weekdays-custom'] as const)
    && (value.recurrence.weekdays === undefined || (Array.isArray(value.recurrence.weekdays)
      && value.recurrence.weekdays.every(day => Number.isInteger(day) && day >= 0 && day <= 6)
      && new Set(value.recurrence.weekdays).size === value.recurrence.weekdays.length))
    && (recurrenceType !== 'weekdays-custom' || (Array.isArray(value.recurrence.weekdays) && value.recurrence.weekdays.length > 0))
    && typeof value.active === 'boolean'
    && (value.goalId === undefined || nonEmpty(value.goalId))
    && timestamp(value.createdAt)
}

function validSettings(value: unknown) {
  if (!record(value) || !record(value.ai) || !record(value.reminders)) return false
  const ai = value.ai
  const reminders = value.reminders
  return Array.isArray(value.areas)
    && value.areas.every(text)
    && typeof ai.enabled === 'boolean'
    && finite(ai.monthlyCap)
    && ai.monthlyCap >= 0
    && text(ai.month)
    && /^\d{4}-\d{2}$/.test(ai.month)
    && finite(ai.estimatedCost)
    && ai.estimatedCost >= 0
    && nonnegativeSafeInteger(ai.inputTokens)
    && nonnegativeSafeInteger(ai.outputTokens)
    && nonnegativeSafeInteger(ai.requests)
    && ['morning', 'evidence', 'recap', 'deadline'].every(key => typeof reminders[key] === 'boolean')
}

function validLegacyData(value: unknown) {
  if (!record(value) || value.schema !== 2) return false
  if (!Array.isArray(value.goals) || !value.goals.every(validGoal)) return false
  if (!Array.isArray(value.tasks) || !value.tasks.every(validTask)) return false
  if (!Array.isArray(value.routines) || !value.routines.every(validRoutine)) return false
  if (!Array.isArray(value.evidence) || !value.evidence.every(item => record(item)
    && nonEmpty(item.id)
    && (item.goalId === undefined || nonEmpty(item.goalId))
    && (item.scheduleId === undefined || nonEmpty(item.scheduleId))
    && oneOf(item.kind, ['photo', 'screenshot', 'number', 'milestone', 'note'] as const)
    && timestamp(item.capturedAt)
    && (item.note === undefined || text(item.note))
    && (item.mediaId === undefined || nonEmpty(item.mediaId))
    && optionalFinite(item.value)
    && (item.milestoneId === undefined || nonEmpty(item.milestoneId)))) return false
  if (!Array.isArray(value.wins) || !value.wins.every(item => record(item)
    && nonEmpty(item.id)
    && nonEmpty(item.title)
    && (item.note === undefined || text(item.note))
    && (item.goalId === undefined || nonEmpty(item.goalId))
    && (item.mediaId === undefined || nonEmpty(item.mediaId))
    && timestamp(item.createdAt))) return false
  if (!Array.isArray(value.progress) || !value.progress.every(item => record(item)
    && nonEmpty(item.id)
    && nonEmpty(item.goalId)
    && finite(item.value)
    && timestamp(item.recordedAt)
    && (item.note === undefined || text(item.note)))) return false
  if (!Array.isArray(value.periods) || !value.periods.every(item => record(item)
    && nonEmpty(item.id)
    && oneOf(item.kind, ['week', 'month', '3M', '6M', 'year'] as const)
    && localDate(item.start)
    && localDate(item.end)
    && localDate(item.availableAt)
    && item.start <= item.end
    && typeof item.finalized === 'boolean')) return false
  if (!validSettings(value.settings) || typeof value.onboarded !== 'boolean' || !timestamp(value.updatedAt)) return false

  const collections = [value.goals, value.tasks, value.routines, value.evidence, value.wins, value.progress, value.periods]
  if (collections.some(collection => !uniqueIds(collection as { id: string }[]))) return false
  const goalIds = new Set(value.goals.map(goal => goal.id))
  const goalsById = new Map(value.goals.map(goal => [goal.id, goal]))
  const validGoalReference = (id: string | undefined) => id === undefined || goalIds.has(id)
  if (!value.tasks.every(task => validGoalReference(task.goalId))) return false
  if (!value.routines.every(routine => validGoalReference(routine.goalId))) return false
  if (!value.evidence.every(item => validGoalReference(item.goalId))) return false
  if (!value.wins.every(win => validGoalReference(win.goalId))) return false
  if (!value.progress.every(item => goalIds.has(item.goalId))) return false
  if (!value.goals.every(goal => goal.links.length === new Set(goal.links).size
    && goal.links.every((link: string) => link !== goal.id && goalIds.has(link)))) return false
  if (!value.evidence.every(item => {
    if (!item.scheduleId && !item.milestoneId) return true
    const relatedGoals = [...new Set([
      ...(Array.isArray(item.goalIds) ? item.goalIds.filter(nonEmpty) : []),
      ...(item.goalId ? [item.goalId] : []),
    ])].flatMap(id => goalsById.get(id) ?? [])
    return relatedGoals.length > 0
      && (!item.scheduleId || relatedGoals.some(goal => goal.evidenceSchedules.some((schedule: Goal['evidenceSchedules'][number]) => schedule.id === item.scheduleId)))
      && (!item.milestoneId || relatedGoals.some(goal => goal.milestones.some((milestone: Goal['milestones'][number]) => milestone.id === item.milestoneId)))
  })) return false
  // rolledToId is historical metadata. Older valid snapshots may retain the
  // original rollover after the destination task has been pruned, so it is not
  // treated as a required live foreign key.
  if (!value.tasks.every(task => task.rolledToId !== task.id)) return false
  return true
}

function validCurrentData(value: unknown): value is AppData {
  if (!record(value) || value.schema !== 3) return false
  if (!validLegacyData({ ...value, schema: 2 })) return false
  if (!Array.isArray(value.measurementHistories) || !value.measurementHistories.every(item => record(item)
    && nonEmpty(item.id) && nonEmpty(item.label) && timestamp(item.createdAt)
    && (item.unit === undefined || text(item.unit))
    && (item.semanticKey === undefined || oneOf(item.semanticKey, ['body-weight', 'savings-balance'] as const))
    && (item.scopeKey === undefined || text(item.scopeKey))
    && (item.mergedIntoId === undefined || nonEmpty(item.mergedIntoId)))
    || !uniqueIds(value.measurementHistories as { id: string }[])) return false
  const historyIds = new Set((value.measurementHistories as Array<{ id: string }>).map(item => item.id))
  if (!(value.goals as unknown[]).every(item => record(item)
    && (item.kind !== 'numeric' || (nonEmpty(item.measurementHistoryId) && historyIds.has(item.measurementHistoryId)))
    && (item.measurementHistoryId === undefined || (nonEmpty(item.measurementHistoryId) && historyIds.has(item.measurementHistoryId)))
    && (item.contextNotes === undefined || (Array.isArray(item.contextNotes) && item.contextNotes.every(text)))
    && (item.deadlineAnchor === undefined || localDate(item.deadlineAnchor))
    && (item.deadlineProvenance === undefined || oneOf(item.deadlineProvenance, ['calendar-default', 'manual', 'legacy-unknown'] as const)))) return false
  if (!(value.goals as Array<Goal>).every(goal => goal.evidenceSchedules.every(schedule => schedule.historyId === undefined || historyIds.has(schedule.historyId)))) return false
  if (!(value.progress as unknown[]).every(item => record(item)
    && (item.historyId === undefined || (nonEmpty(item.historyId) && historyIds.has(item.historyId)))
    && (item.recordedOn === undefined || localDate(item.recordedOn)))) return false
  if (!(value.evidence as unknown[]).every(item => record(item)
    && (item.goalIds === undefined || (Array.isArray(item.goalIds) && item.goalIds.every((id: unknown) => nonEmpty(id) && (value.goals as Array<{ id: string }>).some(goal => goal.id === id)) && new Set(item.goalIds).size === item.goalIds.length))
    && (item.historyId === undefined || (nonEmpty(item.historyId) && historyIds.has(item.historyId)))
    && (item.observationId === undefined || nonEmpty(item.observationId))
    && (item.recordedOn === undefined || localDate(item.recordedOn)))) return false
  const observationIds = new Set((value.progress as Array<{ id: string }>).map(item => item.id))
  if (!(value.evidence as Array<{ observationId?: string }>).every(item => item.observationId === undefined || observationIds.has(item.observationId))) return false
  if (!(value.wins as unknown[]).every(item => record(item)
    && (item.goalIds === undefined || (Array.isArray(item.goalIds) && item.goalIds.every((id: unknown) => nonEmpty(id) && (value.goals as Array<{ id: string }>).some(goal => goal.id === id)) && new Set(item.goalIds).size === item.goalIds.length))
    && (item.recordedOn === undefined || localDate(item.recordedOn)))) return false
  if (!Array.isArray(value.progressLinkSuggestions) || !value.progressLinkSuggestions.every(item => record(item)
    && nonEmpty(item.id) && nonEmpty(item.label) && Array.isArray(item.goalIds) && item.goalIds.every(nonEmpty)
    && Array.isArray(item.historyIds) && item.historyIds.every((id: unknown) => nonEmpty(id) && historyIds.has(id))
    && oneOf(item.status, ['pending', 'confirmed', 'dismissed'] as const) && timestamp(item.createdAt))) return false
  if (!uniqueIds(value.progressLinkSuggestions as { id: string }[])) return false
  if (!Array.isArray(value.routineExclusions) || !value.routineExclusions.every(item => record(item)
    && nonEmpty(item.id) && nonEmpty(item.routineId) && localDate(item.date) && timestamp(item.createdAt))) return false
  if (!uniqueIds(value.routineExclusions as { id: string }[])) return false
  if (!Array.isArray(value.reminderOccurrences) || !value.reminderOccurrences.every(item => record(item)
    && nonEmpty(item.id) && nonEmpty(item.trackId) && nonEmpty(item.scheduleId) && localDate(item.dueDate)
    && oneOf(item.status, ['due', 'snoozed', 'skipped', 'satisfied'] as const)
    && (item.snoozedUntil === undefined || localDate(item.snoozedUntil))
    && (item.handledAt === undefined || timestamp(item.handledAt))
    && (item.satisfiedByEntryId === undefined || nonEmpty(item.satisfiedByEntryId)))) return false
  if (!uniqueIds(value.reminderOccurrences as { id: string }[])) return false
  if (!record(value.planning) || !localDate(value.planning.anchorMonth) || !value.planning.anchorMonth.endsWith('-01') || !localDate(value.planning.trackingStartedOn)) return false
  return true
}

function validMedia(value: unknown): value is BackupMedia {
  return record(value)
    && nonEmpty(value.id)
    && text(value.mimeType)
    && mediaMimeTypes.has(value.mimeType.toLowerCase())
    && positiveSafeInteger(value.bytes)
    && (value.width === undefined || positiveSafeInteger(value.width))
    && (value.height === undefined || positiveSafeInteger(value.height))
    && (value.width === undefined) === (value.height === undefined)
    && timestamp(value.createdAt)
    && text(value.base64)
    && decodedBase64Bytes(value.base64) === value.bytes
}

function bytesToBase64(bytes: Uint8Array) {
  const chunks: string[] = []
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)))
  }
  return btoa(chunks.join(''))
}

function base64ToBytes(value: string) {
  if (!base64Pattern.test(value)) throw new Error('Backup media is not valid base64.')
  const binary = atob(value)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

export async function createBackup(data: AppData, media: MediaRecord[], includeMedia: boolean): Promise<Backup> {
  const backup: Backup = {
    schema: 3,
    exportedAt: new Date().toISOString(),
    data,
    media: undefined,
  }
  if (!includeMedia) {
    if (!validateBackup(backup)) throw new Error('Current Momentum data could not be safely backed up.')
    return backup
  }

  const records = new Map<string, MediaRecord>()
  for (const item of media) {
    if (records.has(item.id)) throw new Error(`Duplicate media record ${item.id} cannot be backed up.`)
    records.set(item.id, item)
  }
  const referencedIds = [...data.evidence, ...data.wins].flatMap(item => item.mediaId ? [item.mediaId] : [])
  const encoded: BackupMedia[] = []
  for (const id of new Set(referencedIds)) {
    const item = records.get(id)
    if (!item) throw new Error(`Referenced media ${id} is missing from local storage.`)
    const bytes = new Uint8Array(await item.blob.arrayBuffer())
    if (bytes.byteLength !== item.bytes) throw new Error(`Stored media size mismatch for ${id}.`)
    encoded.push({
      id: item.id,
      mimeType: item.mimeType,
      bytes: bytes.byteLength,
      width: item.width,
      height: item.height,
      createdAt: item.createdAt,
      base64: bytesToBase64(bytes),
    })
  }
  backup.media = encoded
  if (!validateBackup(backup)) throw new Error('Current Momentum data could not be safely backed up.')
  return backup
}

export function validateBackup(value: unknown): value is Backup {
  if (!record(value) || !timestamp(value.exportedAt) || (value.schema !== 2 && value.schema !== 3)) return false
  if (value.schema === 2) {
    if (!validLegacyData(value.data)) return false
    value.data = migrateSnapshot(value.data)
    value.schema = 3
  }
  if (!validCurrentData(value.data)) return false
  if (value.media !== undefined && (!Array.isArray(value.media) || !value.media.every(validMedia) || !uniqueIds(value.media))) return false
  if (Array.isArray(value.media)) {
    const mediaIds = new Set(value.media.map(item => item.id))
    const references = [...value.data.evidence, ...value.data.wins].flatMap(item => item.mediaId ? [item.mediaId] : [])
    const referencedIds = new Set(references)
    // More than one evidence/win record may intentionally point at the same
    // stored Blob. Backups encode that Blob once while preserving every
    // relationship that refers to it.
    if (![...referencedIds].every(id => mediaIds.has(id))) return false
    if (!value.media.every(item => referencedIds.has(item.id))) return false
  }
  return true
}

export async function restoreMedia(backup: Backup) {
  if (!validateBackup(backup)) throw new Error('Backup validation failed.')
  const restored: MediaRecord[] = []
  for (const item of backup.media ?? []) {
    const bytes = base64ToBytes(item.base64)
    if (bytes.byteLength !== item.bytes) throw new Error(`Backup media size mismatch for ${item.id}.`)
    restored.push({
      id: item.id,
      blob: new Blob([bytes], { type: item.mimeType }),
      mimeType: item.mimeType,
      width: item.width,
      height: item.height,
      bytes: bytes.byteLength,
      createdAt: item.createdAt,
    })
  }
  return restored
}
