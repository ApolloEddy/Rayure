import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_LIVE2D_CORE_URL,
  resolveLive2dCoreUrl,
} from '../src/live2d/core-source.ts'

const BASE_URL = 'http://127.0.0.1:4173/?live2dDebug=1'

test('Live2D Core source accepts the official default, same-origin debug files and loopback URLs', () => {
  assert.equal(resolveLive2dCoreUrl(null, BASE_URL), undefined)
  assert.equal(resolveLive2dCoreUrl(DEFAULT_LIVE2D_CORE_URL, BASE_URL), DEFAULT_LIVE2D_CORE_URL)
  assert.equal(
    resolveLive2dCoreUrl('/@fs/C:/scratch/live2d-core/live2dcubismcore.min.js', BASE_URL),
    'http://127.0.0.1:4173/@fs/C:/scratch/live2d-core/live2dcubismcore.min.js',
  )
  assert.equal(
    resolveLive2dCoreUrl('http://localhost:32145/assets/core/live2dcubismcore.min.js', BASE_URL),
    'http://localhost:32145/assets/core/live2dcubismcore.min.js',
  )
})

test('Live2D Core source rejects arbitrary remote scripts and ambiguous URL forms', () => {
  const invalidValues = [
    'https://evil.example/live2dcubismcore.min.js',
    'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js?cache=1',
    'http://127.0.0.1:32145/core.wasm',
    'http://user@127.0.0.1:32145/live2dcubismcore.min.js',
    'data:text/javascript,alert(1)',
    'javascript:alert(1)',
    '/@fs/C:/scratch/live2d-core/live2dcubismcore.min.js?x=1',
    ' /@fs/C:/scratch/live2d-core/live2dcubismcore.min.js',
    'x'.repeat(2049),
  ]

  for (const value of invalidValues) {
    assert.equal(resolveLive2dCoreUrl(value, BASE_URL), undefined, value)
  }
})

test('Live2D Core source fails closed for malformed base URLs and control characters', () => {
  assert.equal(resolveLive2dCoreUrl('/core.js', 'not a URL'), undefined)
  assert.equal(resolveLive2dCoreUrl('/core\u0000.js', BASE_URL), undefined)
})
