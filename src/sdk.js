/**
 * Loader for the AgentArts Memory SDK.
 *
 * The SDK is loaded at runtime from an absolute path (or a bare package
 * specifier) instead of being an npm dependency, for one concrete reason:
 * `agentarts-sdk-js/packages/agentarts-sdk/package.json` declares
 * `"@huaweicloud/huaweicloud-sdk-agentidentity": "workspace:*"`, and pnpm
 * refuses to install a `file:` dependency that carries a workspace protocol
 * (`ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`). Loading the already-built `dist/`
 * avoids that entirely and keeps this bundle installable as a bare directory.
 *
 * @module dsh-agentarts-memory/sdk
 */

import { pathToFileURL } from 'node:url'
import { isAbsolute } from 'node:path'

/** Cached module namespace, keyed by the specifier that produced it. */
const cache = new Map()

/**
 * Turn a configured value into something `import()` accepts.
 *
 * @param {string} spec - absolute path, `file:` URL or bare package specifier
 * @returns {string}
 */
export function toImportSpecifier(spec) {
  const value = String(spec ?? '').trim()
  if (value === '') throw new Error('sdkPath is empty')
  if (value.startsWith('file:') || value.startsWith('node:') || value.startsWith('data:')) return value
  if (isAbsolute(value)) return pathToFileURL(value).href
  return value
}

/**
 * Load (and cache) the AgentArts Memory SDK module.
 *
 * @param {string} spec - see {@link toImportSpecifier}
 * @returns {Promise<{MemoryClient: Function, MemorySearchFilter: Function, CreateMemoryRequest: Function}>}
 */
export async function loadMemorySdk(spec) {
  const key = String(spec ?? '')
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  const loading = (async () => {
    const specifier = toImportSpecifier(key)
    const mod = await import(specifier)
    if (typeof mod?.MemoryClient !== 'function') {
      throw new Error(`module at ${specifier} does not export MemoryClient`)
    }
    return mod
  })()

  cache.set(key, loading)
  try {
    return await loading
  } catch (error) {
    // Let a later activation retry instead of caching a permanent failure.
    cache.delete(key)
    throw error
  }
}

/** Drop every cached module (tests only). */
export function resetSdkCache() {
  cache.clear()
}
