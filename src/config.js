/**
 * Config resolution and the three capability switches.
 *
 * The plugin is deliberately dependency-free: it does not import any
 * `@deepseek-ai/*` package, so it also does not export a schemastery `Config`.
 * Every value is validated here instead, which keeps `apply()` total — a bad
 * config degrades to defaults plus a warning rather than a failed activation.
 *
 * @module dsh-agentarts-memory/config
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Package subpath of the AgentArts Memory SDK entry point. */
export const SDK_PACKAGE_SUBPATH = '@huaweicloud/agentarts-sdk/sdk/memory'

/** Env var naming an explicit SDK entry point (path or specifier). */
export const SDK_PATH_ENV = 'AGENTARTS_MEMORY_SDK_PATH'

/** Relative location of a sibling `agentarts-sdk-js` checkout, from this module. */
const SDK_SIBLING = '../../agentarts-sdk-js/packages/agentarts-sdk/dist/sdk/memory/index.js'

/**
 * Resolve the SDK entry point without baking a machine-specific path into the
 * package, in priority order:
 *
 * 1. the `sdkPath` config value,
 * 2. `$AGENTARTS_MEMORY_SDK_PATH`,
 * 3. a sibling `agentarts-sdk-js` checkout next to this package (if it exists),
 * 4. the bare package subpath, which resolves when the SDK is installed as a
 *    dependency of the profile.
 *
 * @param {string} [configured] - the `sdkPath` config value
 * @param {Record<string, string|undefined>} [env] - environment source
 * @returns {string}
 */
export function resolveSdkPath(configured, env = process.env) {
  const explicit = asString(configured)
  if (explicit !== '') return explicit

  const fromEnv = asString(env[SDK_PATH_ENV])
  if (fromEnv !== '') return fromEnv

  const sibling = fileURLToPath(new URL(SDK_SIBLING, import.meta.url))
  if (existsSync(sibling)) return sibling

  return SDK_PACKAGE_SUBPATH
}

/** Builtin memory strategies accepted by the AgentArts memory backend. */
export const STRATEGY_TYPES = ['semantic', 'episodic', 'user_preference', 'summary', 'procedural']

/** Environment variable the AgentArts Memory data plane uses for its API key. */
export const DEFAULT_API_KEY_ENV = 'HUAWEICLOUD_SDK_MEMORY_API_KEY'

function asString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback
}

function asBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function asNumber(value, fallback, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/**
 * Resolve a raw bundle config into a fully defaulted configuration.
 *
 * @param {object|undefined} raw - config object from the bundle patch row.
 * @returns {object} resolved configuration
 */
export function resolveConfig(raw) {
  const r = raw !== null && typeof raw === 'object' ? raw : {}
  const recall = r.recall !== null && typeof r.recall === 'object' ? r.recall : {}
  const tools = r.tools !== null && typeof r.tools === 'object' ? r.tools : {}
  const capture = r.capture !== null && typeof r.capture === 'object' ? r.capture : {}

  return {
    enabled: asBool(r.enabled, true),
    spaceId: asString(r.spaceId),
    apiKeyEnv: asString(r.apiKeyEnv) || DEFAULT_API_KEY_ENV,
    region: asString(r.region) || 'cn-southwest-2',
    endpoint: asString(r.endpoint),
    actorId: asString(r.actorId) || 'dsh-user',
    assistantId: asString(r.assistantId) || 'dsh',
    strategyId: asString(r.strategyId),
    strategyType: asString(r.strategyType) || 'semantic',
    sdkPath: resolveSdkPath(r.sdkPath),
    timeoutMs: asNumber(r.timeoutMs, 5000, { min: 100, max: 120000 }),
    recall: {
      enabled: asBool(recall.enabled, true),
      topK: Math.round(asNumber(recall.topK, 5, { min: 1, max: 50 })),
      minScore: asNumber(recall.minScore, 0.35, { min: 0, max: 1 }),
      maxInjectTokens: Math.round(asNumber(recall.maxInjectTokens, 600, { min: 50, max: 8000 })),
      cacheMs: asNumber(recall.cacheMs, 60000, { min: 0, max: 3600000 }),
      minQueryChars: Math.round(asNumber(recall.minQueryChars, 8, { min: 0, max: 2000 })),
    },
    tools: {
      enabled: asBool(tools.enabled, true),
    },
    capture: {
      enabled: asBool(capture.enabled, false),
      maxMessages: Math.round(asNumber(capture.maxMessages, 40, { min: 1, max: 400 })),
    },
  }
}

/**
 * Whether the plugin can talk to the cloud at all: a space id and an API key.
 *
 * @param {object} config - resolved configuration
 * @param {Record<string, string|undefined>} [env] - environment source
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function checkReady(config, env = process.env) {
  if (!config.enabled) return { ok: false, reason: 'plugin disabled (enabled: false)' }
  if (config.spaceId === '') return { ok: false, reason: 'spaceId is not set' }
  if ((env[config.apiKeyEnv] ?? '') === '') {
    return { ok: false, reason: `environment variable ${config.apiKeyEnv} is empty` }
  }
  return { ok: true }
}

/**
 * One-line human readable summary of the switches, used by `/agentarts`.
 *
 * @param {object} config - resolved configuration
 * @returns {string}
 */
export function describeSwitches(config) {
  const flag = (on) => (on ? 'on' : 'off')
  return [
    `plugin ${flag(config.enabled)}`,
    `tools ${flag(config.tools.enabled)}`,
    `recall ${flag(config.recall.enabled)}`,
    `capture ${flag(config.capture.enabled)}`,
  ].join(' · ')
}
