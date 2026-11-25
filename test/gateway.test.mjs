import test from 'node:test'
import assert from 'node:assert/strict'

import { GatewayError, MemoryGateway, normalizeHit, withDeadline, wrapSdkError } from '../src/gateway.js'
import { resolveConfig, resolveSdkPath } from '../src/config.js'
import { toImportSpecifier, loadMemorySdk, resetSdkCache } from '../src/sdk.js'

test('normalizeHit reads the {record, score} shape', () => {
  const hit = normalizeHit({
    record: { id: 'm-1', content: '  the\n user   prefers TypeScript ', strategy_type: 'user_preference' },
    score: 0.87,
  })
  assert.deepEqual(hit, {
    id: 'm-1',
    content: 'the user prefers TypeScript',
    score: 0.87,
    strategyType: 'user_preference',
  })
})

test('normalizeHit also reads a flat record', () => {
  const hit = normalizeHit({ id: 'm-2', content: 'flat', score: 0.5 })
  assert.equal(hit.id, 'm-2')
  assert.equal(hit.content, 'flat')
  assert.equal(hit.score, 0.5)
})

test('normalizeHit never throws on junk', () => {
  assert.deepEqual(normalizeHit(undefined), { id: '', content: '', score: 0, strategyType: '' })
  assert.deepEqual(normalizeHit({ record: 'text' }), { id: '', content: '', score: 0, strategyType: '' })
})

test('withDeadline resolves a fast call', async () => {
  assert.equal(await withDeadline(Promise.resolve(7), 50, undefined, 'op'), 7)
})

test('withDeadline rejects with a timeout code', async () => {
  const slow = new Promise((resolve) => setTimeout(resolve, 100))
  await assert.rejects(withDeadline(slow, 10, undefined, 'op'), (error) => {
    assert.ok(error instanceof GatewayError)
    assert.equal(error.code, 'timeout')
    assert.match(error.message, /op exceeded 10ms/)
    return true
  })
})

test('withDeadline forwards an abort signal', async () => {
  const controller = new AbortController()
  const slow = new Promise((resolve) => setTimeout(resolve, 100))
  const pending = withDeadline(slow, 1000, controller.signal, 'op')
  controller.abort()
  await assert.rejects(pending, (error) => error.code === 'aborted')
})

test('withDeadline rejects immediately on an already-aborted signal', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(withDeadline(Promise.resolve(1), 50, controller.signal, 'op'), (error) => error.code === 'aborted')
})

test('wrapSdkError keeps GatewayError and wraps the rest', () => {
  const original = new GatewayError('api', 'boom')
  assert.equal(wrapSdkError(original, 'op'), original)
  const wrapped = wrapSdkError(new Error('boom'), 'op')
  assert.equal(wrapped.code, 'api')
  assert.match(wrapped.message, /op failed: boom/)
})

test('toImportSpecifier converts paths and keeps specifiers', () => {
  assert.equal(toImportSpecifier('/a/b.js'), 'file:///a/b.js')
  assert.equal(toImportSpecifier('file:///a/b.js'), 'file:///a/b.js')
  assert.equal(toImportSpecifier('@scope/pkg'), '@scope/pkg')
  assert.throws(() => toImportSpecifier('   '), /empty/)
})

test('gateway reports unconfigured without network access', async () => {
  const gateway = new MemoryGateway(resolveConfig({ spaceId: 'sp-1' }), {})
  await assert.rejects(gateway.search('x'), (error) => {
    assert.equal(error.code, 'unconfigured')
    assert.match(error.message, /HUAWEICLOUD_SDK_MEMORY_API_KEY/)
    return true
  })
  await gateway.close()
})

test('gateway reports a missing space separately from a missing key', async () => {
  const gateway = new MemoryGateway(resolveConfig({}), { HUAWEICLOUD_SDK_MEMORY_API_KEY: 'k' })
  await assert.rejects(gateway.search('x'), (error) => {
    assert.equal(error.code, 'unconfigured')
    assert.match(error.message, /spaceId/)
    return true
  })
})

test('gateway surfaces an unloadable SDK path', async () => {
  resetSdkCache()
  const gateway = new MemoryGateway(
    resolveConfig({ spaceId: 'sp-1', sdkPath: '/nonexistent/agentarts/memory/index.js' }),
    { HUAWEICLOUD_SDK_MEMORY_API_KEY: 'k' },
  )
  await assert.rejects(gateway.search('x'), (error) => {
    assert.equal(error.code, 'sdk')
    return true
  })
  resetSdkCache()
})

test('loadMemorySdk caches by specifier', async () => {
  resetSdkCache()
  const spec = resolveSdkPath()
  let first
  try {
    first = await loadMemorySdk(spec)
  } catch {
    // The SDK checkout may be absent on another machine; the cache contract is
    // what this test is about, so skip when it cannot be loaded at all.
    return
  }
  const second = await loadMemorySdk(spec)
  assert.equal(first, second)
  assert.equal(typeof first.MemoryClient, 'function')
  resetSdkCache()
})
