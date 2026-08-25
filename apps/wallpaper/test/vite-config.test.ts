import assert from 'node:assert/strict'
import test from 'node:test'

import viteConfig, { decodeSingleFileName } from '../vite.config.ts'

test('dev asset routes reject malformed encoding and multi-segment paths', () => {
  assert.equal(decodeSingleFileName('core-skin-data.json'), 'core-skin-data.json')
  assert.equal(decodeSingleFileName('%E5%B2%9B%E9%A3%8E.pmx'), '岛风.pmx')
  assert.equal(decodeSingleFileName('%E0%A4%A'), undefined)
  assert.equal(decodeSingleFileName('..%2Fsecret.json'), undefined)
  assert.equal(decodeSingleFileName('nested%5Csecret.json'), undefined)
  assert.equal(decodeSingleFileName('a'.repeat(256)), undefined)
})

test('Vite filesystem gateway stays confined to the wallpaper app', () => {
  const allow = viteConfig.server?.fs?.allow ?? []
  assert.equal(allow.length, 1)
  assert.equal(allow.some(path => /[\\/]scratch[\\/]/iu.test(path)), false)
})

test('local private asset routes are installed for both dev and built preview', () => {
  const plugins = (viteConfig.plugins ?? []) as unknown as readonly {
    name?: string
    configureServer?: unknown
    configurePreviewServer?: unknown
  }[]
  for (const name of ['rayure-private-scene-archive', 'rayure-ardy-debug-assets']) {
    const plugin = plugins.find(candidate => candidate.name === name)
    assert.equal(typeof plugin?.configureServer, 'function')
    assert.equal(typeof plugin?.configurePreviewServer, 'function')
  }
})
