/**
 * The cloud gateway: a thin, fail-open adapter over the AgentArts Memory SDK.
 *
 * Responsibilities kept here (and nowhere else):
 * - lazy client construction and API key lookup,
 * - a hard deadline per call, forwarded from the caller's abort signal,
 * - normalising the SDK's wire shapes into the two records this plugin uses,
 * - translating every failure into a {@link GatewayError} so callers can decide
 *   to degrade instead of throwing into the agent loop.
 *
 * Everything is opt-in and read-mostly: `search` and `save` are the only calls
 * the tools and the recall hook need.
 *
 * @module dsh-agentarts-memory/gateway
 */

import { loadMemorySdk } from './sdk.js'

/** Failure of one gateway call. `code` is stable and safe to branch on. */
export class GatewayError extends Error {
  /**
   * @param {string} code - `unconfigured` | `timeout` | `aborted` | `sdk` | `api`
   * @param {string} message - human readable detail
   */
  constructor(code, message) {
    super(message)
    this.name = 'GatewayError'
    this.code = code
  }
}

/** One normalised memory hit. */
/**
 * @typedef {object} MemoryHit
 * @property {string} id - cloud memory record id, empty when absent
 * @property {string} content - the memory text
 * @property {number} score - similarity score, 0 when absent
 * @property {string} strategyType - builtin strategy name, empty when absent
 */

/**
 * Race `promise` against a deadline and an optional abort signal.
 *
 * @param {Promise<any>} promise - the in-flight SDK call
 * @param {number} timeoutMs - hard deadline
 * @param {AbortSignal|undefined} signal - caller cancellation
 * @param {string} label - operation name used in error messages
 * @returns {Promise<any>}
 */
export function withDeadline(promise, timeoutMs, signal, label) {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer

    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer)
      if (signal !== undefined && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort)
      }
    }
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      cleanup()
      fn(value)
    }
    const onAbort = () => settle(reject, new GatewayError('aborted', `${label} aborted`))

    if (signal?.aborted === true) {
      onAbort()
      return
    }
    if (signal !== undefined && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true })
    }
    timer = setTimeout(
      () => settle(reject, new GatewayError('timeout', `${label} exceeded ${timeoutMs}ms`)),
      timeoutMs,
    )

    Promise.resolve(promise).then(
      (value) => settle(resolve, value),
      (error) => settle(reject, wrapSdkError(error, label)),
    )
  })
}

/**
 * Translate an SDK/transport failure into a {@link GatewayError}.
 *
 * @param {unknown} error - whatever the SDK threw
 * @param {string} label - operation name used in the message
 * @returns {GatewayError}
 */
export function wrapSdkError(error, label) {
  if (error instanceof GatewayError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new GatewayError('api', `${label} failed: ${message}`)
}

/**
 * Pull our two fields out of one search result, tolerating both wire shapes the
 * backend has been seen to use (`{record, score}` and a flat record).
 *
 * @param {unknown} raw - one entry of `MemorySearchResponse.results`
 * @returns {MemoryHit}
 */
export function normalizeHit(raw) {
  const holder = raw !== null && typeof raw === 'object' ? raw : {}
  const record =
    holder.record !== null && typeof holder.record === 'object' ? holder.record : holder
  const score = typeof holder.score === 'number' && Number.isFinite(holder.score) ? holder.score : 0

  const content =
    typeof record.content === 'string'
      ? record.content
      : typeof record.text === 'string'
        ? record.text
        : typeof holder.content === 'string'
          ? holder.content
          : ''

  return {
    id: typeof record.id === 'string' ? record.id : '',
    content: content.replace(/\s+/g, ' ').trim(),
    score,
    strategyType:
      typeof record.strategy_type === 'string'
        ? record.strategy_type
        : typeof record.strategyType === 'string'
          ? record.strategyType
          : '',
  }
}

/** The memory gateway. One instance per plugin activation. */
export class MemoryGateway {
  #config
  #env
  #client
  #closing = false

  /**
   * @param {object} config - resolved configuration (see `resolveConfig`)
   * @param {Record<string, string|undefined>} [env] - environment source
   */
  constructor(config, env = process.env) {
    this.#config = config
    this.#env = env
  }

  /** The API key, read late so a shell change is picked up without a restart. */
  get apiKey() {
    return this.#env[this.#config.apiKeyEnv] ?? ''
  }

  /**
   * Create (and memoize) the SDK client.
   *
   * @returns {Promise<{client: object, mod: object}>}
   */
  async #ensureClient() {
    if (this.#client !== undefined) return this.#client
    if (this.apiKey === '') {
      throw new GatewayError('unconfigured', `environment variable ${this.#config.apiKeyEnv} is empty`)
    }
    if (this.#config.spaceId === '') {
      throw new GatewayError('unconfigured', 'spaceId is not set')
    }

    let mod
    try {
      mod = await loadMemorySdk(this.#config.sdkPath)
    } catch (error) {
      throw new GatewayError(
        'sdk',
        `cannot load the AgentArts Memory SDK from ${this.#config.sdkPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }

    // The SDK derives its data-plane base URL from the environment at
    // construction time, so a private or custom endpoint must be published
    // before the client exists.
    if (this.#config.endpoint !== '' && (this.#env.AGENTARTS_MEMORY_DATA_ENDPOINT ?? '') === '') {
      this.#env.AGENTARTS_MEMORY_DATA_ENDPOINT = this.#config.endpoint
    }

    const client = new mod.MemoryClient({
      apiKey: this.apiKey,
      regionName: this.#config.region,
    })
    this.#client = { client, mod }
    return this.#client
  }

  /**
   * Semantic search over the space.
   *
   * @param {string} query - natural language query
   * @param {{topK?: number, minScore?: number, strategyType?: string, signal?: AbortSignal}} [options]
   * @returns {Promise<MemoryHit[]>}
   */
  async search(query, options = {}) {
    const { client, mod } = await this.#ensureClient()
    const { topK, minScore, strategyType, signal } = options

    const filters = new mod.MemorySearchFilter({
      query,
      topK: topK ?? this.#config.recall.topK,
      minScore: minScore ?? this.#config.recall.minScore,
      actorId: this.#config.actorId,
      assistantId: this.#config.assistantId,
      ...(typeof strategyType === 'string' && strategyType !== '' ? { strategyType } : {}),
    })

    const response = await withDeadline(
      client.searchMemories(this.#config.spaceId, filters),
      this.#config.timeoutMs,
      signal,
      'memory search',
    )

    const results = Array.isArray(response?.results) ? response.results : []
    return results.map(normalizeHit).filter((hit) => hit.content !== '')
  }

  /**
   * Write one memory record directly (no server-side extraction involved).
   *
   * @param {{content: string, strategyType?: string, metadata?: Record<string, unknown>}} input
   * @returns {Promise<{id: string, content: string}>}
   */
  async save(input) {
    const { client, mod } = await this.#ensureClient()
    const content = String(input?.content ?? '').trim()
    if (content === '') throw new GatewayError('api', 'content must not be empty')

    const request = new mod.CreateMemoryRequest({
      content,
      strategyType: input?.strategyType ?? this.#config.strategyType,
      strategyId: this.#config.strategyId,
      actorId: this.#config.actorId,
      assistantId: this.#config.assistantId,
      ...(input?.metadata !== undefined ? { metadata: input.metadata } : {}),
    })

    const created = await withDeadline(
      client.createMemory(this.#config.spaceId, request),
      this.#config.timeoutMs,
      undefined,
      'memory save',
    )
    return { id: String(created?.id ?? ''), content: String(created?.content ?? content) }
  }

  /**
   * Delete one memory record.
   *
   * @param {string} id - cloud memory record id
   * @returns {Promise<void>}
   */
  async remove(id) {
    const { client } = await this.#ensureClient()
    await withDeadline(
      client.deleteMemory(this.#config.spaceId, String(id)),
      this.#config.timeoutMs,
      undefined,
      'memory delete',
    )
  }

  /**
   * Push conversation messages so the platform extracts long-term memories.
   *
   * @param {string} sessionId - DSH session id, reused as the cloud session id
   * @param {Array<{role: string, content: string}>} messages - plain text turns
   * @returns {Promise<number>} number of messages accepted
   */
  async pushMessages(sessionId, messages) {
    const { client, mod } = await this.#ensureClient()
    if (!Array.isArray(messages) || messages.length === 0) return 0

    const id = String(sessionId ?? '').trim()
    if (id === '') throw new GatewayError('api', 'session id must not be empty')

    try {
      await withDeadline(
        client.createMemorySession(this.#config.spaceId, id, this.#config.actorId, this.#config.assistantId),
        this.#config.timeoutMs,
        undefined,
        'memory session create',
      )
    } catch (error) {
      // A session that already exists is the normal case after the first turn;
      // only a non-conflict failure is worth reporting.
      const message = error instanceof Error ? error.message : String(error)
      if (!/exist|conflict|duplicate|409/i.test(message)) throw wrapSdkError(error, 'memory session create')
    }

    const textMessages = messages.map(
      (message) => new mod.TextMessage({ role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content }),
    )

    const batch = await withDeadline(
      client.addMessages(this.#config.spaceId, id, textMessages, {
        idempotencyKey: id,
        isForceExtract: true,
      }),
      this.#config.timeoutMs,
      undefined,
      'memory message push',
    )
    return Array.isArray(batch?.items) ? batch.items.length : textMessages.length
  }

  /** Release the underlying HTTP client, best effort. */
  async close() {
    if (this.#closing) return
    this.#closing = true
    const held = this.#client
    this.#client = undefined
    if (held === undefined) return
    try {
      await held.client.close()
    } catch {
      // Closing a client that never opened a socket is not an error worth surfacing.
    }
  }
}
