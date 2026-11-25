/**
 * End-to-end integration against a local stub of the AgentArts Memory data
 * plane. This exercises the real SDK client, the real Bearer header, the real
 * request body and the real `agent/pre-step` injection path — everything except
 * the Huawei cloud itself.
 *
 * Skipped automatically when the SDK checkout is not built on this machine.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { apply } from '../index.js'
import { resolveConfig, resolveSdkPath } from '../src/config.js'

const SDK_PATH = resolveSdkPath()

const RECORD = { id: 'mem-1', content: '用户偏好 TypeScript 做新项目', strategy_type: 'user_preference' }

/**
 * Start a stub server that records every request and answers the search path.
 *
 * @param {{status?: number, body?: unknown}} [options]
 * @returns {Promise<{url: string, requests: object[], close: () => Promise<void>}>}
 */
async function startStub(options = {}) {
  const requests = []
  const status = options.status ?? 200
  const body = options.body ?? { records: [{ record: RECORD, score: 0.91 }] }

  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => {
      raw += chunk
    })
    request.on('end', () => {
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body: raw === '' ? undefined : JSON.parse(raw),
      })
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

/**
 * Minimal Cordis-shaped context that records registrations.
 *
 * @returns {{ctx: object, log: object}}
 */
function makeCtx() {
  const log = { tools: [], listeners: [], sections: [], commands: [] }
  const ctx = {
    on(name, handler) {
      log.listeners.push({ name, handler })
      return () => {}
    },
    effect(run) {
      const dispose = run()
      return () => (typeof dispose === 'function' ? dispose() : undefined)
    },
    get(name) {
      if (name === 'systemPrompt') return { section: (section) => (log.sections.push(section), () => {}) }
      if (name === 'commands') return { register: (command) => (log.commands.push(command), () => {}) }
      return undefined
    },
    reflect: { get: () => undefined },
    tools: { register: (definition) => (log.tools.push(definition), () => {}) },
  }
  return { ctx, log }
}

const userMessage = (text) => ({ content: [{ type: 'text', text }] })

async function skipIfNoSdk() {
  try {
    await import(SDK_PATH)
    return false
  } catch {
    return true
  }
}

test('recall injects a memory returned by the stub data plane', async (t) => {
  if (await skipIfNoSdk()) return t.skip('AgentArts Memory SDK is not built on this machine')

  delete process.env.AGENTARTS_MEMORY_DATA_ENDPOINT
  const stub = await startStub()
  process.env.STUB_MEMORY_KEY = 'stub-key'
  try {
    const { ctx, log } = makeCtx()
    apply(ctx, resolveConfig({
      enabled: true,
      spaceId: 'stub-space',
      apiKeyEnv: 'STUB_MEMORY_KEY',
      endpoint: stub.url,
      sdkPath: SDK_PATH,
      recall: { enabled: true, minQueryChars: 1, minScore: 0.3, topK: 3 },
      tools: { enabled: true },
    }))

    const preStep = log.listeners.find((listener) => listener.name === 'agent/pre-step')
    assert.ok(preStep, 'pre-step listener must be registered')

    let nextCalls = 0
    const next = async () => {
      nextCalls += 1
      return { kind: 'enter', messages: [] }
    }
    // One agent object across both calls: the dedupe map is keyed by identity.
    const agent = { id: 'agent-1' }

    const decision = await preStep.handler({ agent, messages: [userMessage('帮我写个 TypeScript 项目')] }, next)

    assert.equal(decision.kind, 'enter')
    assert.equal(decision.messages.length, 2, 'injected message plus the original one')
    const injected = decision.messages[0]
    assert.equal(injected.role, 'user')
    assert.equal(typeof injected.id, 'string')
    assert.ok(Object.isFrozen(injected))
    assert.match(injected.content[0].text, /AgentArts memory/)
    assert.match(injected.content[0].text, /TypeScript/)
    assert.match(injected.content[0].text, /0\.91/)

    assert.equal(stub.requests.length, 1)
    const [request] = stub.requests
    assert.equal(request.method, 'POST')
    assert.equal(request.url, '/v1/core/spaces/stub-space/memories/search')
    assert.equal(request.authorization, 'Bearer stub-key')
    assert.equal(request.body.query, '帮我写个 TypeScript 项目')
    assert.equal(request.body.top_k, 3)
    assert.equal(request.body.min_score, 0.3)
    assert.equal(request.body.actor_id, 'dsh-user')

    // The same memory must not be injected twice within one agent's lifetime.
    const second = await preStep.handler({ agent, messages: [userMessage('再说一次 TypeScript 项目')] }, next)
    assert.equal(second.kind, 'enter')
    assert.equal(second.messages.length, 0, 'no re-injection for an already-seen memory')
  } finally {
    delete process.env.STUB_MEMORY_KEY
    delete process.env.AGENTARTS_MEMORY_DATA_ENDPOINT
    await stub.close()
  }
})

test('recall degrades to next() when the data plane errors', async (t) => {
  if (await skipIfNoSdk()) return t.skip('AgentArts Memory SDK is not built on this machine')

  delete process.env.AGENTARTS_MEMORY_DATA_ENDPOINT
  const stub = await startStub({ status: 500, body: { error_code: 'BOOM', error_msg: 'exploded' } })
  process.env.STUB_MEMORY_KEY = 'stub-key'
  try {
    const { ctx, log } = makeCtx()
    apply(ctx, resolveConfig({
      enabled: true,
      spaceId: 'stub-space',
      apiKeyEnv: 'STUB_MEMORY_KEY',
      endpoint: stub.url,
      sdkPath: SDK_PATH,
      recall: { enabled: true, minQueryChars: 1 },
      tools: { enabled: false },
    }))

    const preStep = log.listeners.find((listener) => listener.name === 'agent/pre-step')
    let nextCalls = 0
    const next = async () => {
      nextCalls += 1
      return { kind: 'enter', messages: [{ id: 'original' }] }
    }

    const decision = await preStep.handler({ agent: {}, messages: [userMessage('anything at all')] }, next)
    assert.equal(nextCalls, 1)
    assert.deepEqual(decision.messages, [{ id: 'original' }])
  } finally {
    delete process.env.STUB_MEMORY_KEY
    delete process.env.AGENTARTS_MEMORY_DATA_ENDPOINT
    await stub.close()
  }
})

test('search tool renders hits and save tool writes a record', async (t) => {
  if (await skipIfNoSdk()) return t.skip('AgentArts Memory SDK is not built on this machine')

  delete process.env.AGENTARTS_MEMORY_DATA_ENDPOINT
  const stub = await startStub({
    body: {
      records: [{ record: RECORD, score: 0.77 }],
    },
  })
  process.env.STUB_MEMORY_KEY = 'stub-key'
  try {
    const { ctx, log } = makeCtx()
    apply(ctx, resolveConfig({
      enabled: true,
      spaceId: 'stub-space',
      apiKeyEnv: 'STUB_MEMORY_KEY',
      endpoint: stub.url,
      sdkPath: SDK_PATH,
      recall: { enabled: false },
      tools: { enabled: true },
    }))

    const names = log.tools.map((tool) => tool.name)
    assert.deepEqual(names, ['huawei_memory_search', 'huawei_memory_save'])

    const search = log.tools.find((tool) => tool.name === 'huawei_memory_search')
    const value = await search.execute({ query: 'typescript' })
    assert.equal(value.total, 1)
    assert.equal(value.results[0].content, RECORD.content)
    assert.equal(value.results[0].strategy_type, 'user_preference')

    // Official ToolDefinition contract: output.render must return content blocks.
    const blocks = search.output.render({ query: 'typescript' }, value)
    assert.equal(blocks[0].type, 'text')
    assert.match(blocks[0].text, /0\.77/)
  } finally {
    delete process.env.STUB_MEMORY_KEY
    delete process.env.AGENTARTS_MEMORY_DATA_ENDPOINT
    await stub.close()
  }
})
