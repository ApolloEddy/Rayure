import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { EnvironmentHost } from '../src/environment-host.ts'

test('EnvironmentHost instantiates and handles fallback lighting gracefully', () => {
  const scene = new THREE.Scene()
  const env = new EnvironmentHost(scene)
  assert.ok(env)

  // 释放资源测试
  env.dispose()
  assert.equal(scene.children.length, 0)
})

test('EnvironmentHost handles disposed state correctly', async () => {
  const scene = new THREE.Scene()
  const env = new EnvironmentHost(scene)
  env.dispose()

  const loaded = await env.load()
  assert.equal(loaded, false)
  assert.equal(scene.children.length, 0)
})
