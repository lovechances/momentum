import type { Settings } from './domain'
import { todayLocal } from './domain'
import { AI_MODEL, AI_PRICE_PER_MILLION } from './ai-config'

export { AI_MODEL }
export const PRICE_PER_MILLION = AI_PRICE_PER_MILLION
export const AI_REQUEST_RESERVE = 0.01
export const currentMonth = (date = new Date()) => todayLocal(date).slice(0, 7)

export type AiAction = 'plan' | 'today' | 'week' | 'recap'

export type AiSuggestion = {
  id: string
  goalId: string
  title: string
  nextStep: string
  reason: string
  estimatedMinutes: number
  existingTaskId: string
}

export type AiClarification = { goalId: string; question: string }

export type AiTodayResult = {
  kind: 'today'
  suggestions: AiSuggestion[]
  clarification: AiClarification
}

export type AiPlanResult = {
  kind: 'plan'
  goalId: string
  clarifiedGoal: string
  milestones: string[]
  suggestions: AiSuggestion[]
  evidenceSuggestions: string[]
  goalLinks: Array<{ goalId: string; reason: string }>
  notes: string
  clarification: AiClarification
}

export type AiPerspectiveResult = {
  kind: 'week' | 'recap'
  summary: string
  highlights: string[]
  nextFocus: string
}

export type AiResult = AiTodayResult | AiPlanResult | AiPerspectiveResult

export type AiUsage = { input_tokens: number; output_tokens: number }
export type AiResponse = { output: AiResult; usage?: AiUsage }

export function applyMonthlyReset(ai: Settings['ai'], date = new Date()): Settings['ai'] {
  const month = currentMonth(date)
  return ai.month === month
    ? ai
    : { ...ai, month, estimatedCost: 0, inputTokens: 0, outputTokens: 0, requests: 0 }
}

export function canCallAi(ai: Settings['ai'], reservedCost = AI_REQUEST_RESERVE, date = new Date()) {
  const usage = applyMonthlyReset(ai, date)
  return usage.monthlyCap > 0 && usage.estimatedCost + Math.max(0, reservedCost) <= usage.monthlyCap
}

export function estimateCost(inputTokens: number, outputTokens: number) {
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens) || inputTokens < 0 || outputTokens < 0) {
    throw new Error('Token usage must be non-negative.')
  }
  const cost = inputTokens / 1_000_000 * PRICE_PER_MILLION.input
    + outputTokens / 1_000_000 * PRICE_PER_MILLION.output
  if (!Number.isFinite(cost)) throw new Error('Token usage is too large.')
  return cost
}

export function recordAiUsage(ai: Settings['ai'], inputTokens: number, outputTokens: number, date = new Date()) {
  const usage = applyMonthlyReset(ai, date)
  return {
    ...usage,
    requests: usage.requests + 1,
    inputTokens: usage.inputTokens + inputTokens,
    outputTokens: usage.outputTokens + outputTokens,
    estimatedCost: usage.estimatedCost + estimateCost(inputTokens, outputTokens),
  }
}

/** Record a completed request even if an upstream response omits token usage. */
export function recordAiResponse(ai: Settings['ai'], usage?: AiUsage, date = new Date()) {
  if (usage) return recordAiUsage(ai, usage.input_tokens, usage.output_tokens, date)
  const current = applyMonthlyReset(ai, date)
  return { ...current, requests: current.requests + 1, estimatedCost: current.estimatedCost + AI_REQUEST_RESERVE }
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value)
  && typeof value === 'object'
  && !Array.isArray(value)

const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).sort().join('|') === [...keys].sort().join('|')

const boundedString = (value: unknown, max: number, allowEmpty = true) => typeof value === 'string'
  && value.length <= max
  && (allowEmpty || value.trim().length > 0)

const boundedStrings = (value: unknown, maxItems: number, maxLength: number) => Array.isArray(value)
  && value.length <= maxItems
  && value.every(item => boundedString(item, maxLength, false))

function validateSuggestion(value: unknown): value is AiSuggestion {
  if (!isRecord(value) || !exactKeys(value, ['estimatedMinutes', 'existingTaskId', 'goalId', 'id', 'nextStep', 'reason', 'title'])) return false
  return boundedString(value.id, 128, false)
    && boundedString(value.goalId, 128)
    && boundedString(value.title, 160, false)
    && boundedString(value.nextStep, 600, false)
    && boundedString(value.reason, 360, false)
    && Number.isSafeInteger(value.estimatedMinutes)
    && Number(value.estimatedMinutes) >= 0
    && Number(value.estimatedMinutes) <= 480
    && boundedString(value.existingTaskId, 128)
}

const hasUniqueSuggestionIds = (value: unknown[]) => {
  const ids = value.flatMap(item => isRecord(item) && typeof item.id === 'string' ? [item.id] : [])
  return ids.length === value.length && new Set(ids).size === ids.length
}

function validateClarification(value: unknown): value is AiClarification {
  if (!isRecord(value) || !exactKeys(value, ['goalId', 'question'])) return false
  if (typeof value.goalId !== 'string' || typeof value.question !== 'string') return false
  if (!boundedString(value.goalId, 128) || !boundedString(value.question, 360)) return false
  return Boolean(value.goalId) === Boolean(value.question.trim())
}

export function validateAiResult(action: AiAction, value: unknown): value is AiResult {
  if (!isRecord(value)) return false
  if (action === 'today') {
    return exactKeys(value, ['clarification', 'kind', 'suggestions'])
      && value.kind === 'today'
      && Array.isArray(value.suggestions)
      && value.suggestions.length <= 3
      && value.suggestions.every(validateSuggestion)
      && hasUniqueSuggestionIds(value.suggestions)
      && validateClarification(value.clarification)
      && (value.suggestions.length > 0 || Boolean(value.clarification.question))
  }
  if (action === 'plan') {
    return exactKeys(value, ['clarification', 'clarifiedGoal', 'evidenceSuggestions', 'goalId', 'goalLinks', 'kind', 'milestones', 'notes', 'suggestions'])
      && value.kind === 'plan'
      && boundedString(value.goalId, 128, false)
      && boundedString(value.clarifiedGoal, 500, false)
      && boundedStrings(value.milestones, 10, 500)
      && Array.isArray(value.suggestions)
      && value.suggestions.length <= 3
      && value.suggestions.every(validateSuggestion)
      && hasUniqueSuggestionIds(value.suggestions)
      && boundedStrings(value.evidenceSuggestions, 8, 500)
      && Array.isArray(value.goalLinks)
      && value.goalLinks.length <= 8
      && value.goalLinks.every(item => isRecord(item)
        && exactKeys(item, ['goalId', 'reason'])
        && boundedString(item.goalId, 128, false)
        && boundedString(item.reason, 360, false))
      && boundedString(value.notes, 1_500)
      && validateClarification(value.clarification)
  }
  return exactKeys(value, ['highlights', 'kind', 'nextFocus', 'summary'])
    && value.kind === action
    && boundedString(value.summary, 1_500, false)
    && boundedStrings(value.highlights, 8, 500)
    && boundedString(value.nextFocus, 600)
}

function validateUsage(value: unknown): value is AiUsage {
  if (!isRecord(value)) return false
  return Number.isSafeInteger(value.input_tokens)
    && Number(value.input_tokens) >= 0
    && Number.isSafeInteger(value.output_tokens)
    && Number(value.output_tokens) >= 0
}

const statusMessage = (status: number) => {
  if (status === 503) return 'AI is not configured.'
  if (status === 401 || status === 403) return 'AI authentication failed. Check the server configuration.'
  if (status === 429) return 'AI is temporarily rate limited.'
  if (status === 504) return 'AI request timed out.'
  if (status === 502) return 'AI returned an unusable response. Try again.'
  if (status >= 400 && status < 500) return 'AI request was rejected.'
  return 'AI is unavailable right now.'
}

export async function aiRequest(
  action: AiAction,
  context: unknown,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<AiResponse> {
  if (options.signal?.aborted) throw new DOMException('Request canceled.', 'AbortError')
  const controller = new AbortController()
  let timedOut = false
  const timeoutMs = Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) >= 0
    ? Number(options.timeoutMs)
    : 20_000
  const timeout = globalThis.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const cancel = () => controller.abort()
  if (options.signal?.aborted) cancel()
  else options.signal?.addEventListener('abort', cancel, { once: true })
  try {
    const response = await fetch('/api/ai', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, context }),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(statusMessage(response.status))

    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new Error('AI returned an unreadable response.')
    }
    if (!isRecord(body) || !validateAiResult(action, body.output)) throw new Error('AI returned an invalid response.')
    const usage = validateUsage(body.usage)
      ? { input_tokens: body.usage.input_tokens, output_tokens: body.usage.output_tokens }
      : undefined
    return { output: body.output, ...(usage ? { usage } : {}) }
  } catch (error) {
    if (timedOut) throw new Error('AI request timed out.')
    if (options.signal?.aborted) throw new DOMException('Request canceled.', 'AbortError')
    if (error instanceof Error && error.message.startsWith('AI ')) throw error
    throw new Error('AI is unavailable right now.')
  } finally {
    globalThis.clearTimeout(timeout)
    options.signal?.removeEventListener('abort', cancel)
  }
}
