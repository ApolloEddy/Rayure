import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { loadLocalConfig } from '../src/local-config.ts'

test('local config accepts an external feature cache and a loopback Text Encoder endpoint', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rayure-motion-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const configPath = join(root, 'rayure.local.json')
  const cachePath = join(root, 'motion-features.json')
  await writeFile(configPath, JSON.stringify({
    motionSemantic: {
      cachePath,
      textEncoder: {
        endpoint: 'http://127.0.0.1:9550/encode',
      },
    },
  }))

  const config = await loadLocalConfig(configPath)
  assert.deepEqual(config.motionSemantic, {
    cachePath,
    textEncoder: {
      endpoint: 'http://127.0.0.1:9550/encode',
      timeoutMs: 10_000,
    },
  })
})

test('local config rejects unsafe or ambiguous motion semantic settings', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rayure-motion-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const configPath = join(root, 'rayure.local.json')
  const invalidValues: unknown[] = [
    { motionSemantic: {} },
    { motionSemantic: { cachePath: 'relative.json' } },
    { motionSemantic: { cachePath: join(root, 'features.bin') } },
    { motionSemantic: { textEncoder: { endpoint: 'http://encoder.example.test/encode' } } },
    { motionSemantic: { textEncoder: { endpoint: 'https://encoder.example.test/encode?token=secret' } } },
    { motionSemantic: { cachePath: join(root, 'features.json'), extra: true } },
    { motionSemantic: { ardy: { command: 'python', args: 'bridge.py' } } },
    { motionSemantic: { ardy: { command: 'python', args: [], cwd: 'relative' } } },
  ]

  for (const value of invalidValues) {
    await writeFile(configPath, JSON.stringify(value))
    await assert.rejects(loadLocalConfig(configPath), /motionSemantic|cachePath|endpoint|HTTPS|JSON|cwd/i, JSON.stringify(value))
  }
})

test('local config resolves an external ARDY process without enabling a shell', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rayure-motion-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const configPath = join(root, 'rayure.local.json')
  await writeFile(configPath, JSON.stringify({
    motionSemantic: {
      ardy: {
        command: 'python',
        args: ['bridge.py', '--stdio'],
        cwd: root,
        requestTimeoutMs: 5_000,
      },
    },
  }))

  const config = await loadLocalConfig(configPath)
  assert.deepEqual(config.motionSemantic?.ardy, {
    command: 'python',
    args: ['bridge.py', '--stdio'],
    cwd: root,
    requestTimeoutMs: 5_000,
  })
})
