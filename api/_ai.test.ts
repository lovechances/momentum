// The leading underscore keeps this regression suite out of Vercel's /api route discovery.
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import handler, {
  AI_MAX_CONTEXT_CHARACTERS,
  AI_MAX_OUTPUT_TOKENS,
  AI_MODEL,
  validateAiResult as validateServerResult,
} from './ai'
import { aiRequest, validateAiResult as validateClientResult } from '../src/ai'
import {
  AI_MAX_CONTEXT_CHARACTERS as CLIENT_MAX_CONTEXT_CHARACTERS,
  AI_MAX_OUTPUT_TOKENS as CLIENT_MAX_OUTPUT_TOKENS,
  AI_MODEL as CLIENT_MODEL,
} from '../src/ai-config'

const suggestion = {
  id: 'suggestion-1',
  goalId: 'goal-buyee',
  title: 'Test one alert',
  nextStep: 'Trace one listing through Discord and record any failure.',
  reason: 'This advances the next unfinished validation milestone.',
  estimatedMinutes: 20,
  existingTaskId: '',
}

const todayResult = {
  kind: 'today' as const,
  suggestions: [suggestion],
  clarification: { goalId: '', question: '' },
}

const planResult = {
  kind: 'plan' as const,
  goalId: 'goal-buyee',
  clarifiedGoal: 'Validate one Buyee alert from listing to Discord.',
  milestones: ['Trace one live listing', 'Record the first failure'],
  suggestions: [suggestion],
  evidenceSuggestions: ['Save a weekly validation note'],
  goalLinks: [{ goalId: 'goal-business', reason: 'The alert validates the larger business path.' }],
  notes: 'Use the existing flow before adding scope.',
  clarification: { goalId: '', question: '' },
}

const perspectiveResult = {
  kind: 'week' as const,
  summary: 'Two goal moves were completed and one remains open.',
  highlights: ['The validation milestone moved forward.'],
  nextFocus: 'Finish the remaining alert trace.',
}

const recapResult = { ...perspectiveResult, kind: 'recap' as const }

const todayContext = {
  contextState: 'supplied',
  localDate: '2026-09-15',
  timeZone: 'America/New_York',
  goals: [
    { id: 'goal-buyee', title: 'Finish Buyee', status: 'active', horizon: '1M', measurementHistoryId: '' },
    { id: 'goal-business', title: 'Start a business', status: 'active', horizon: '3M', measurementHistoryId: '' },
  ],
  tasks: [],
  recentProgress: [],
}

const planContext = {
  contextState: 'supplied',
  goal: { id: 'goal-buyee', title: 'Finish Buyee' },
  relatedGoals: [{ id: 'goal-business', title: 'Start a business' }],
  tasks: [],
  recentProgress: [],
}

type Result = { status: number; body?: any; ended: boolean; headers: Record<string, string> }

function responseHarness() {
  const result: Result = { status: 200, ended: false, headers: {} }
  const response = {
    status: vi.fn((status: number) => { result.status = status; return response }),
    json: vi.fn((body: unknown) => { result.body = body; return response }),
    end: vi.fn(() => { result.ended = true; return response }),
    setHeader: vi.fn((name: string, value: string) => { result.headers[name.toLowerCase()] = value; return response }),
  }
  return { response, result }
}

async function callHandler(body: unknown, method = 'POST') {
  const { response, result } = responseHarness()
  await handler({ method, body }, response)
  return result
}

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
})

const completedResponse = (output: unknown, usage: unknown = { input_tokens: 101, output_tokens: 42 }) =>
  jsonResponse({ status: 'completed', output_text: JSON.stringify(output), usage })

function expectStrictObjectSchema(value: unknown) {
  expect(value).toEqual(expect.any(Object))
  const schema = value as Record<string, unknown>
  if (schema.type === 'object') {
    expect(schema.additionalProperties).toBe(false)
    const properties = schema.properties as Record<string, unknown>
    expect([...schema.required as string[]].sort()).toEqual(Object.keys(properties).sort())
    for (const property of Object.values(properties)) expectStrictObjectSchema(property)
  } else if (schema.type === 'array') {
    expectStrictObjectSchema(schema.items)
  }
  if (Array.isArray(schema.anyOf)) {
    for (const option of schema.anyOf) expectStrictObjectSchema(option)
  }
}

describe('serverless AI boundary', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.stubEnv('OPENAI_API_KEY', 'unit-test-placeholder')
    fetchMock = vi.fn(async () => { throw new Error('Unexpected upstream request in test') })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('emits a self-contained Node ESM entry that loads without local resolution', async () => {
    const source = await readFile(new URL('./ai.ts', import.meta.url), 'utf8')
    const emitted = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
      fileName: 'api/ai.ts',
      reportDiagnostics: true,
    })
    expect(emitted.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error) ?? []).toEqual([])
    expect(emitted.outputText).not.toMatch(/(?:from\s*|import\s*\()\s*['"]\.{1,2}\//)
    const loaded = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(emitted.outputText).toString('base64')}`)
    expect(loaded.default).toBeTypeOf('function')
  })

  it('keeps server constants and feature validators aligned with the client', () => {
    expect([AI_MODEL, AI_MAX_OUTPUT_TOKENS, AI_MAX_CONTEXT_CHARACTERS]).toEqual([
      CLIENT_MODEL, CLIENT_MAX_OUTPUT_TOKENS, CLIENT_MAX_CONTEXT_CHARACTERS,
    ])
    for (const [action, output] of [['today', todayResult], ['plan', planResult], ['week', perspectiveResult], ['recap', recapResult]] as const) {
      expect(validateServerResult(action, output)).toBe(true)
      expect(validateClientResult(action, output)).toBe(true)
    }
    const unlinkedQuestion = { ...todayResult, clarification: { goalId: '', question: 'Which goal should this advance?' } }
    const emptyPlanLink = { ...planResult, goalLinks: [{ goalId: '', reason: 'Missing relationship.' }] }
    expect(validateServerResult('today', unlinkedQuestion)).toBe(false)
    expect(validateClientResult('today', unlinkedQuestion)).toBe(false)
    expect(validateServerResult('plan', emptyPlanLink)).toBe(false)
    expect(validateClientResult('plan', emptyPlanLink)).toBe(false)
    const duplicateSuggestionIds = {
      ...todayResult,
      suggestions: [suggestion, { ...suggestion, title: 'Call one customer' }],
    }
    expect(validateServerResult('today', duplicateSuggestionIds)).toBe(false)
    expect(validateClientResult('today', duplicateSuggestionIds)).toBe(false)
  })

  it('allows only POST and marks every response non-cacheable', async () => {
    const result = await callHandler(undefined, 'GET')
    expect(result).toMatchObject({ status: 405, ended: true, headers: { allow: 'POST', 'cache-control': 'no-store' } })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails safely when the key is missing', async () => {
    vi.stubEnv('OPENAI_API_KEY', '')
    expect(await callHandler({ action: 'today', context: todayContext })).toMatchObject({ status: 503, body: { error: 'AI is not configured.' } })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['unsupported action', { action: 'delete-everything', context: todayContext }, 400],
    ['missing context marker', { action: 'today', context: { ...todayContext, contextState: undefined } }, 400],
    ['missing task context', { action: 'today', context: { ...todayContext, tasks: undefined } }, 400],
    ['missing perspective facts', { action: 'week', context: { contextState: 'supplied' } }, 400],
    ['image field', { action: 'today', context: { ...todayContext, imageUrl: 'https://example.test/a.jpg' } }, 400],
    ['inline image', { action: 'today', context: { ...todayContext, note: 'data:image/png;base64,AAAA' } }, 400],
    ['oversized context', { action: 'today', context: { ...todayContext, padding: 'x'.repeat(AI_MAX_CONTEXT_CHARACTERS) } }, 413],
  ])('rejects %s before OpenAI', async (_label, body, status) => {
    expect((await callHandler(body)).status).toBe(status)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a circular context without crashing or calling OpenAI', async () => {
    const context: Record<string, unknown> = { ...todayContext }
    context.self = context
    expect(await callHandler({ action: 'today', context })).toMatchObject({ status: 400, body: { error: 'Invalid AI context.' } })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sanitizes an unexpected application failure across the whole handler', async () => {
    const privateDetail = 'private detail that must not escape'
    const request = { method: 'POST' } as { method: string; body: unknown }
    Object.defineProperty(request, 'body', { get: () => { throw new Error(privateDetail) } })
    const { response, result } = responseHarness()
    await handler(request, response)
    expect(result).toMatchObject({ status: 500, body: { error: 'AI request failed.' }, headers: { 'cache-control': 'no-store' } })
    expect(JSON.stringify(result.body)).not.toContain(privateDetail)
  })

  it.each([[401, 401], [429, 429], [500, 502]])('normalizes upstream HTTP %i to %i', async (upstream, expected) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'private upstream text' } }, upstream))
    const result = await callHandler({ action: 'today', context: todayContext })
    expect(result).toMatchObject({ status: expected, body: { error: 'AI request failed.' } })
    expect(JSON.stringify(result.body)).not.toContain('private upstream text')
  })

  it.each([
    ['network', new Error('offline'), 502],
    ['timeout', Object.assign(new Error('elapsed'), { name: 'TimeoutError' }), 504],
  ])('normalizes %s failure', async (_label, error, status) => {
    fetchMock.mockRejectedValueOnce(error)
    const result = await callHandler({ action: 'today', context: todayContext })
    expect(result.status).toBe(status)
  })

  it('rejects incomplete, unreadable, and structurally invalid model output', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: JSON.stringify(todayResult) }))
    expect(await callHandler({ action: 'today', context: todayContext })).toMatchObject({ status: 502, body: { error: 'AI response was incomplete. Try again.' } })

    fetchMock.mockResolvedValueOnce(new Response('{', { status: 200 }))
    expect(await callHandler({ action: 'today', context: todayContext })).toMatchObject({ status: 502, body: { error: 'AI returned an unreadable response.' } })

    fetchMock.mockResolvedValueOnce(completedResponse({ ...todayResult, suggestions: [{ ...suggestion, reason: '' }] }))
    expect(await callHandler({ action: 'today', context: todayContext })).toMatchObject({ status: 502, body: { error: 'AI returned invalid structured output.' } })
  })

  it('uses feature-specific Today instructions/schema and sends the exact bounded context', async () => {
    fetchMock.mockResolvedValueOnce(completedResponse(todayResult))
    const result = await callHandler({ action: 'today', context: todayContext, model: 'expensive-model' })
    expect(result).toMatchObject({ status: 200, body: { output: todayResult, usage: { input_tokens: 101, output_tokens: 42 } } })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const request = JSON.parse(init.body as string)
    expect(url).toBe('https://api.openai.com/v1/responses')
    expect(request).toMatchObject({
      model: AI_MODEL,
      store: false,
      reasoning: { effort: 'none' },
      max_output_tokens: AI_MAX_OUTPUT_TOKENS,
      truncation: 'disabled',
      text: { format: { type: 'json_schema', name: 'momentum_today', strict: true } },
    })
    expect(request.instructions).toContain('concrete actions the user can perform today')
    expect(request.instructions).toContain('Never propose changes to Momentum')
    expect(request.instructions).not.toContain('break the selected goal into')
    expect(JSON.parse(request.input)).toEqual(todayContext)
    expect(request.input).not.toContain('expensive-model')
    expect(request.text.format.schema.type).toBe('object')
    expectStrictObjectSchema(request.text.format.schema)
  })

  it('preserves valid goal/task IDs and exposes invalid relationships for repair', async () => {
    const context = {
      ...todayContext,
      tasks: [{ id: 'task-open', title: 'Trace alert', done: false, status: 'active' }],
    }
    fetchMock.mockResolvedValueOnce(completedResponse({
      ...todayResult,
      suggestions: [
        { ...suggestion, existingTaskId: 'task-open' },
        { ...suggestion, id: 'bad-link', title: 'Call one customer', goalId: 'not-supplied', existingTaskId: 'not-supplied' },
      ],
    }))
    const result = await callHandler({ action: 'today', context })
    expect(result.body.output.suggestions).toEqual([
      { ...suggestion, existingTaskId: 'task-open' },
      { ...suggestion, id: 'bad-link', title: 'Call one customer', goalId: '', existingTaskId: '' },
    ])
  })

  it('normalizes task reuse only to active unfinished tasks and reuses an exact active title', async () => {
    const context = {
      ...todayContext,
      tasks: [
        { id: 'task-deleted', title: 'Deleted move', done: false, status: 'deleted' },
        { id: 'task-excluded', title: 'Excluded move', done: false, status: 'excluded' },
        { id: 'task-active', title: 'Reuse active move', done: false, status: 'active' },
      ],
    }
    fetchMock.mockResolvedValueOnce(completedResponse({
      ...todayResult,
      suggestions: [
        { ...suggestion, id: 'deleted', title: 'Deleted move', existingTaskId: 'task-deleted' },
        { ...suggestion, id: 'excluded', title: 'Excluded move', existingTaskId: 'task-excluded' },
        { ...suggestion, id: 'active', title: 'Reuse active move', existingTaskId: 'task-deleted' },
      ],
    }))
    const result = await callHandler({ action: 'today', context })
    expect(result.body.output.suggestions).toEqual([
      expect.objectContaining({ id: 'deleted', existingTaskId: '' }),
      expect.objectContaining({ id: 'excluded', existingTaskId: '' }),
      expect.objectContaining({ id: 'active', existingTaskId: 'task-active' }),
    ])
  })

  it('never returns routine occurrences as reusable one-off task IDs', async () => {
    const context = {
      ...todayContext,
      tasks: [
        { id: 'routine-kind', title: 'Morning walk', done: false, status: 'active', kind: 'routine', sourceRoutineId: 'routine' },
        { id: 'routine-source', title: 'Drink water', done: false, status: 'active', kind: 'task', sourceRoutineId: 'water-routine' },
      ],
    }
    fetchMock.mockResolvedValueOnce(completedResponse({
      ...todayResult,
      suggestions: [
        { ...suggestion, id: 'routine-kind-suggestion', title: 'Morning walk', existingTaskId: 'routine-kind' },
        { ...suggestion, id: 'routine-source-suggestion', title: 'Drink water', existingTaskId: 'routine-source' },
      ],
    }))
    const result = await callHandler({ action: 'today', context })
    expect(result.body.output.suggestions.map((item: typeof suggestion) => item.existingTaskId)).toEqual(['', ''])
  })

  it('rejects duplicate suggestion IDs before returning model output', async () => {
    fetchMock.mockResolvedValueOnce(completedResponse({
      ...todayResult,
      suggestions: [suggestion, { ...suggestion, title: 'Call one customer' }],
    }))
    expect(await callHandler({ action: 'today', context: todayContext })).toMatchObject({
      status: 502,
      body: { error: 'AI returned invalid structured output.' },
    })
  })

  it('removes exact completed duplicates and duplicate suggestions for one shared history', async () => {
    const context = {
      ...todayContext,
      goals: [
        { ...todayContext.goals[0], measurementHistoryId: 'weight' },
        { ...todayContext.goals[1], measurementHistoryId: 'weight' },
      ],
      tasks: [{ id: 'done-1', title: 'Test one alert', done: true, status: 'active' }],
    }
    fetchMock.mockResolvedValueOnce(completedResponse({
      ...todayResult,
      suggestions: [
        suggestion,
        { ...suggestion, id: 'weight-1', title: 'Record today’s weight' },
        { ...suggestion, id: 'weight-2', goalId: 'goal-business', title: 'Take a second weight reading' },
      ],
    }))
    const result = await callHandler({ action: 'today', context })
    expect(result.body.output.suggestions).toHaveLength(1)
    expect(result.body.output.suggestions[0].title).toBe('Record today’s weight')
  })

  it('deduplicates Plan suggestions across the selected and related goals shared history', async () => {
    const context = {
      ...planContext,
      goal: { ...planContext.goal, measurementHistoryId: 'shared-weight' },
      relatedGoals: [{ ...planContext.relatedGoals[0], measurementHistoryId: 'shared-weight' }],
    }
    fetchMock.mockResolvedValueOnce(completedResponse({
      ...planResult,
      suggestions: [
        { ...suggestion, id: 'plan-weight-1', title: 'Record weight once' },
        { ...suggestion, id: 'plan-weight-2', goalId: 'goal-business', title: 'Record another weight' },
      ],
    }))
    const result = await callHandler({ action: 'plan', context })
    expect(result.status).toBe(200)
    expect(result.body.output.suggestions).toEqual([
      expect.objectContaining({ id: 'plan-weight-1', goalId: 'goal-buyee' }),
    ])
  })

  it('supports one focused clarification instead of generic filler', async () => {
    const clarification = { kind: 'today', suggestions: [], clarification: { goalId: 'goal-business', question: 'What customer problem is this business meant to solve first?' } }
    fetchMock.mockResolvedValueOnce(completedResponse(clarification))
    expect(await callHandler({ action: 'today', context: todayContext })).toMatchObject({ status: 200, body: { output: clarification } })
  })

  it('clears an invalid clarification relationship as a valid no-question state', async () => {
    fetchMock.mockResolvedValueOnce(completedResponse({
      ...todayResult,
      clarification: { goalId: 'not-supplied', question: 'What is missing?' },
    }))
    const result = await callHandler({ action: 'today', context: todayContext })
    expect(result).toMatchObject({ status: 200, body: { output: { clarification: { goalId: '', question: '' } } } })
    expect(validateServerResult('today', result.body.output)).toBe(true)
    expect(validateClientResult('today', result.body.output)).toBe(true)
  })

  it('drops invalid and self-referential plan links without invalidating the response', async () => {
    const returned = {
      ...planResult,
      goalLinks: [
        ...planResult.goalLinks,
        { goalId: 'not-supplied', reason: 'This ID was not sent.' },
        { goalId: 'goal-buyee', reason: 'A goal cannot link to itself.' },
      ],
    }
    fetchMock.mockResolvedValueOnce(completedResponse(returned))
    const result = await callHandler({ action: 'plan', context: planContext })
    expect(result).toMatchObject({ status: 200, body: { output: { goalLinks: planResult.goalLinks } } })
    expect(validateServerResult('plan', result.body.output)).toBe(true)
    expect(validateClientResult('plan', result.body.output)).toBe(true)
  })

  it('reads structured output from the raw Responses output array and omits unsafe usage', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(todayResult) }] }],
      usage: { input_tokens: 'private', output_tokens: -1 },
    }))
    const result = await callHandler({ action: 'today', context: todayContext })
    expect(result).toMatchObject({ status: 200, body: { output: todayResult } })
    expect(result.body).not.toHaveProperty('usage')
  })

  it('uses separate plan and perspective contracts', async () => {
    fetchMock.mockResolvedValueOnce(completedResponse(planResult))
    expect(await callHandler({ action: 'plan', context: planContext })).toMatchObject({ status: 200, body: { output: planResult } })
    let request = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(request.text.format.name).toBe('momentum_plan')
    expect(request.instructions).toContain('selected goal')
    expectStrictObjectSchema(request.text.format.schema)

    fetchMock.mockResolvedValueOnce(completedResponse(perspectiveResult))
    expect(await callHandler({ action: 'week', context: { contextState: 'supplied', facts: { goalMoves: { done: 2, due: 3 } } } })).toMatchObject({ status: 200, body: { output: perspectiveResult } })
    request = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)
    expect(request.text.format.name).toBe('momentum_week')
    expect(request.instructions).toContain('computed weekly facts')
    expectStrictObjectSchema(request.text.format.schema)
  })
})

describe('browser AI client', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock) })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('returns only the action-specific validated output and safe usage', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ output: todayResult, usage: { input_tokens: 10, output_tokens: 20, extra: 'ignored' }, extra: 'ignored' }))
    await expect(aiRequest('today', todayContext)).resolves.toEqual({ output: todayResult, usage: { input_tokens: 10, output_tokens: 20 } })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ action: 'today', context: todayContext })
  })

  it.each([
    [503, 'AI is not configured.'],
    [401, 'AI authentication failed. Check the server configuration.'],
    [429, 'AI is temporarily rate limited.'],
    [502, 'AI returned an unusable response. Try again.'],
    [504, 'AI request timed out.'],
  ])('maps HTTP %i to a stable message', async (status, message) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'untrusted server text' }, status))
    await expect(aiRequest('today', todayContext)).rejects.toThrow(message)
  })

  it('rejects the wrong feature contract', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ output: planResult }))
    await expect(aiRequest('today', todayContext)).rejects.toThrow('AI returned an invalid response.')
  })

  it('handles timeout and explicit cancellation separately', async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject((init.signal as AbortSignal).reason), { once: true })
    }))
    await expect(aiRequest('today', todayContext, { timeoutMs: 5 })).rejects.toThrow('AI request timed out.')
    const controller = new AbortController()
    const pending = aiRequest('today', todayContext, { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
