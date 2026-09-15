import type { Settings } from './domain'
import { todayLocal } from './domain'
import { AI_MODEL, AI_PRICE_PER_MILLION } from './ai-config'

export { AI_MODEL }
export const PRICE_PER_MILLION = AI_PRICE_PER_MILLION
export const AI_REQUEST_RESERVE = 0.01
export const currentMonth = (date = new Date()) => todayLocal(date).slice(0, 7)

export type AiPlan = {
  clarifiedGoal: string
  milestones: string[]
  actions: string[]
  evidenceSuggestions: string[]
  goalLinks: string[]
  notes: string
}

export type AiUsage = {
  input_tokens: number
  output_tokens: number
}

export type AiResponse = {
  output: AiPlan
  usage?: AiUsage
}

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

const boundedStrings = (value: unknown, maxItems: number) => Array.isArray(value)
  && value.length <= maxItems
  && value.every(item => typeof item === 'string' && item.length <= 1_000)

const planKeys = ['actions', 'clarifiedGoal', 'evidenceSuggestions', 'goalLinks', 'milestones', 'notes']

export function validatePlan(value: unknown): value is AiPlan {
  if (!value || typeof value !== 'object') return false
  const plan = value as Record<string, unknown>
  return Object.keys(plan).sort().join('|') === planKeys.join('|')
    && typeof plan.clarifiedGoal === 'string'
    && plan.clarifiedGoal.length <= 2_000
    && boundedStrings(plan.milestones, 12)
    && boundedStrings(plan.actions, 12)
    && boundedStrings(plan.evidenceSuggestions, 12)
    && boundedStrings(plan.goalLinks, 12)
    && typeof plan.notes === 'string'
    && plan.notes.length <= 4_000
}

function validateUsage(value: unknown): value is AiUsage {
  if (!value || typeof value !== 'object') return false
  const usage = value as Record<string, unknown>
  return Number.isSafeInteger(usage.input_tokens)
    && (usage.input_tokens as number) >= 0
    && Number.isSafeInteger(usage.output_tokens)
    && (usage.output_tokens as number) >= 0
}

const statusMessage = (status: number) => {
  if (status === 503) return 'AI is not configured.'
  if (status === 401 || status === 403) return 'AI authentication failed. Check the server configuration.'
  if (status === 429) return 'AI is temporarily rate limited.'
  if (status === 504) return 'AI request timed out.'
  if (status >= 400 && status < 500) return 'AI request was rejected.'
  return 'AI is unavailable right now.'
}

export async function aiRequest(
  action: 'plan' | 'today' | 'week' | 'recap',
  context: unknown,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<AiResponse> {
  if (options.signal?.aborted) throw new DOMException('Request canceled.', 'AbortError')
  const controller = new AbortController()
  let timedOut = false
  const timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs as number) >= 0
    ? options.timeoutMs as number
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
    if (!body || typeof body !== 'object') throw new Error('AI returned an invalid response.')
    const payload = body as Record<string, unknown>
    if (!validatePlan(payload.output)) throw new Error('AI returned an invalid response.')
    const usage = validateUsage(payload.usage)
      ? { input_tokens: payload.usage.input_tokens, output_tokens: payload.usage.output_tokens }
      : undefined
    return {
      output: payload.output,
      ...(usage ? { usage } : {}),
    }
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
