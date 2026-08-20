import assert from 'node:assert/strict'
import test from 'node:test'

import { dirname, extname, join } from '../src/live2d/path-browser.ts'

test('browser path shim preserves remote Live2D URL bases', () => {
  const modelUrl = 'http://127.0.0.1:32145/assets/token/Hiyori.model3.json'
  const base = dirname(modelUrl)
  assert.equal(base, 'http://127.0.0.1:32145/assets/token')
  assert.equal(join(base, 'Hiyori.moc3'), 'http://127.0.0.1:32145/assets/token/Hiyori.moc3')
  assert.equal(extname(modelUrl), '.json')
})

test('browser path shim retains ordinary relative path behavior', () => {
  assert.equal(dirname('scratch/live2d/Hiyori.model3.json'), 'scratch/live2d')
  assert.equal(join('scratch/live2d', 'Hiyori.moc3'), 'scratch/live2d/Hiyori.moc3')
})
