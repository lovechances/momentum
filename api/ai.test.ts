import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import handler from './ai'
import { aiRequest } from '../src/ai'
import { AI_MAX_CONTEXT_CHARACTERS, AI_MAX_OUTPUT_TOKENS, AI_MODEL } from '../src/ai-config'

const validPlan = {
  clarifiedGoal: 'Ship a small release',
  milestones: ['Verify the release candidate'],
  actions: ['Run the clean test suite'],
  evidenceSuggestions: ['Save the build result'],
  goalLinks: [],
  notes: 'Keep the scope small.',
}

type Result = {
  status: number
  body?: unknown
  ended: boolean
  headers: Record<string, string>
}

function responseHarness() {
  const result: Result = { status: 200, ended: false, headers: {} }
  const response = {
    status: vi.fn((status: number) => {
      result.status = status
      return response
    }),
    json: vi.fn((body: unknown) => {
      result.body = body
      return response
    }),
    end: vi.fn(() => {
      result.ended = true
      return response
    }),
    setHeader: vi.fn((name: string, value: string) => {
      result.headers[name.toLowerCase()] = value
      return response
    }),
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

describe('serverless AI boundary', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.stubEnv('OPENAI_API_KEY', 'unit-test-placeholder')
    fetchMock = vi.fn(async () => {
      throw new Error('Unexpected upstream request in test')
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('allows only POST and marks every response as non-cacheable', async () => {
    const result = await callHandler(undefined, 'GET')
    expect(result).toMatchObject({ status: 405, ended: true })
    expect(result.headers).toMatchObject({ allow: 'POST', 'cache-control': 'no-store' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails safely when the server key is missing', async () => {
    vi.stubEnv('OPENAI_API_KEY', '')
    const result = await callHandler({ action: 'plan', context: {} })
    expect(result).toMatchObject({ status: 503, body: { error: 'AI is not configured.' } })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['unsupported action', { action: 'delete-everything', context: {} }, 400],
    ['primitive context', { action: 'plan', context: 42 }, 400],
    ['array context', { action: 'plan', context: [] }, 400],
    ['oversized context', { action: 'plan', context: { text: 'x'.repeat(AI_MAX_CONTEXT_CHARACTERS + 1) } }, 413],
    ['image field', { action: 'plan', context: { imageUrl: 'https://example.test/evidence.jpg' } }, 400],
    ['inline image data', { action: 'plan', context: { note: 'data:image/png;base64,AAAA' } }, 400],
  ])('rejects %s before any upstream call', async (_label, body, status) => {
    const result = await callHandler(body)
    expect(result.status).toBe(status)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a non-serializable context without crashing', async () => {
    const context: Record<string, unknown> = {}
    context.self = context
    const result = await callHandler({ action: 'plan', context })
    expect(result.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    [401, 401],
    [429, 429],
    [500, 502],
  ])('normalizes upstream HTTP %i to safe status %i without leaking its body', async (upstreamStatus, expectedStatus) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'sensitive upstream detail' } }, upstreamStatus))
    const result = await callHandler({ action: 'today', context: {} })
    expect(result).toMatchObject({ status: expectedStatus, body: { error: 'AI request failed.' } })
  })

  it.each([
    ['network failure', new Error('offline'), 502],
    ['timeout', Object.assign(new Error('elapsed'), { name: 'TimeoutError' }), 504],
    ['abort', Object.assign(new Error('aborted'), { name: 'AbortError' }), 504],
  ])('normalizes an upstream %s', async (_label, error, status) => {
    fetchMock.mockRejectedValueOnce(error)
    const result = await callHandler({ action: 'week', context: {} })
    expect(result.status).toBe(status)
    expect(result.body).toEqual({ error: status === 504 ? 'AI request timed out.' : 'AI request failed.' })
  })

  it.each([
    ['unreadable JSON', new Response('{', { status: 200 }), 'AI returned an unreadable response.'],
    ['missing output', jsonResponse({ usage: {} }), 'AI returned no structured output.'],
    ['malformed output JSON', jsonResponse({ output_text: '{' }), 'AI returned malformed structured output.'],
    ['wrong output schema', jsonResponse({ output_text: JSON.stringify({ ...validPlan, actions: [1] }) }), 'AI returned invalid structured output.'],
    ['extra output fields', jsonResponse({ output_text: JSON.stringify({ ...validPlan, activateNow: true }) }), 'AI returned invalid structured output.'],
  ])('rejects %s from a successful upstream response', async (_label, response, message) => {
    fetchMock.mockResolvedValueOnce(response)
    const result = await callHandler({ action: 'recap', context: { facts: { wins: ['Shipped'] } } })
    expect(result).toMatchObject({ status: 502, body: { error: message } })
  })

  it('uses the fixed cheap model, privacy flag, output cap, strict schema, and proposal-only instructions', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      output: [{ content: [{ type: 'output_text', text: JSON.stringify(validPlan) }] }],
      usage: { input_tokens: 101, output_tokens: 42, private_detail: 'not forwarded' },
    }))
    const result = await callHandler({ action: 'plan', context: { goal: { title: 'Release' } }, model: 'expensive-model' })

    expect(result).toEqual(expect.objectContaining({
      status: 200,
      body: { output: validPlan, usage: { input_tokens: 101, output_tokens: 42 } },
    }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const request = JSON.parse(init.body as string)
    expect(url).toBe('https://api.openai.com/v1/responses')
    expect(request).toMatchObject({
      model: AI_MODEL,
      store: false,
      reasoning: { effort: 'none' },
      max_output_tokens: AI_MAX_OUTPUT_TOKENS,
      text: { format: { type: 'json_schema', name: 'momentum_result', strict: true } },
    })
    expect(AI_MODEL).toBe('gpt-5.4-nano')
    expect(request.instructions).toContain('user must explicitly approve each change')
    expect(request.input).not.toContain('expensive-model')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('omits malformed token usage while preserving a valid proposal', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ output_text: JSON.stringify(validPlan), usage: { input_tokens: 'many', output_tokens: -1 } }))
    const result = await callHandler({ action: 'today', context: {} })
    expect(result).toMatchObject({ status: 200, body: { output: validPlan } })
    expect(result.body).not.toHaveProperty('usage')
  })
})

describe('browser AI client', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('returns only a validated plan and safe token usage', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      output: validPlan,
      usage: { input_tokens: 10, output_tokens: 20, extra: 'ignored' },
      extra: 'ignored',
    }))
    await expect(aiRequest('today', { goals: [] })).resolves.toEqual({
      output: validPlan,
      usage: { input_tokens: 10, output_tokens: 20 },
    })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ action: 'today', context: { goals: [] } })
  })

  it.each([
    [503, 'AI is not configured.'],
    [401, 'AI authentication failed. Check the server configuration.'],
    [429, 'AI is temporarily rate limited.'],
    [504, 'AI request timed out.'],
    [500, 'AI is unavailable right now.'],
  ])('maps HTTP %i to a stable user-facing error', async (status, message) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'do not trust server details' }, status))
    await expect(aiRequest('plan', {})).rejects.toThrow(message)
  })

  it('rejects unreadable JSON and invalid structured output', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{', { status: 200 }))
    await expect(aiRequest('week', {})).rejects.toThrow('AI returned an unreadable response.')

    fetchMock.mockResolvedValueOnce(jsonResponse({ output: { ...validPlan, notes: 7 } }))
    await expect(aiRequest('week', {})).rejects.toThrow('AI returned an invalid response.')
  })

  it('normalizes network failures without exposing their details', async () => {
    fetchMock.mockRejectedValueOnce(new Error('device-specific private network detail'))
    await expect(aiRequest('recap', {})).rejects.toThrow('AI is unavailable right now.')
  })

  it('ends a stalled request at the client timeout', async () => {
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject((init.signal as AbortSignal).reason), { once: true })
    }))
    await expect(aiRequest('plan', {}, { timeoutMs: 5 })).rejects.toThrow('AI request timed out.')
  })

  it('preserves explicit user cancellation as AbortError and skips an already-canceled call', async () => {
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject((init.signal as AbortSignal).reason), { once: true })
    }))
    const active = new AbortController()
    const pending = aiRequest('today', {}, { signal: active.signal })
    active.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })

    const alreadyCanceled = new AbortController()
    alreadyCanceled.abort()
    await expect(aiRequest('today', {}, { signal: alreadyCanceled.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
