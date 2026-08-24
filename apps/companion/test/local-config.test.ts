import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { loadLocalConfig } from '../src/local-config.ts'

test('missing optional local config produces no model source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rayure-config-'))
  await assert.doesNotReject(async () => {
    assert.deepEqual(await loadLocalConfig(join(root, 'missing.json'), { optional: true }), {})
  })
  await rm(root, { recursive: true, force: true })
})

test('local config resolves one existing PMX without exposing extra fields', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rayure-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const modelPath = join(root, 'model.pmx')
  const configPath = join(root, 'rayure.local.json')
  await writeFile(modelPath, 'pmx')
  await writeFile(configPath, JSON.stringify({
    model: {
      id: 'local-test-model',
      displayName: 'Local test model',
      format: 'pmx',
      path: modelPath,
    },
  }))

  const config = await loadLocalConfig(configPath)
  assert.equal(config.model?.entryFilePath, modelPath)
  assert.equal(config.model?.displayName, 'Local test model')
})

test('local config resolves a Live2D model3 entry without exposing extra fields', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rayure-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const modelPath = join(root, 'Hiyori.model3.json')
  const configPath = join(root, 'rayure.local.json')
  await writeFile(modelPath, '{"Version":3}')
  await writeFile(configPath, JSON.stringify({
    model: {
      id: 'hiyori-debug',
      displayName: 'Hiyori debug',
      format: 'live2d',
      path: modelPath,
    },
  }))

  const config = await loadLocalConfig(configPath)
  assert.deepEqual(config.model, {
    id: 'hiyori-debug',
    displayName: 'Hiyori debug',
    format: 'live2d',
    entryFilePath: modelPath,
  })
})

test('local config rejects malformed JSON, unknown fields and unsafe model inputs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rayure-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const configPath = join(root, 'rayure.local.json')
  const invalidValues: unknown[] = [
    null,
    [],
    { extra: true },
    { model: null },
    { model: { id: 'bad id', displayName: 'Model', format: 'pmx', path: 'model.pmx' } },
    { model: { id: 'model', displayName: '', format: 'pmx', path: 'model.pmx' } },
    { model: { id: 'model', displayName: 'Model', format: 'fbx', path: 'model.fbx' } },
    { model: { id: 'model', displayName: 'Model', format: 'pmx', path: 'relative.pmx' } },
    { model: { id: 'model', displayName: 'Model', format: 'pmx', path: join(root, 'missing.pmx') } },
    { model: { id: 'model', displayName: 'Model', format: 'live2d', path: join(root, 'model.json') } },
    { model: { id: 'model', displayName: 'Model', format: 'pmx', path: join(root, 'model.pmx'), extra: true } },
  ]

  for (const value of invalidValues) {
    await writeFile(configPath, JSON.stringify(value))
    await assert.rejects(loadLocalConfig(configPath), /local config|model|PMX|exist|JSON/i, JSON.stringify(value))
  }
  await writeFile(configPath, '{')
  await assert.rejects(loadLocalConfig(configPath), /JSON/i)
})

test('local config resolves configured motions and rejects invalid motion paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rayure-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const motionPath = join(root, 'wave.vmd')
  const configPath = join(root, 'rayure.local.json')
  await writeFile(motionPath, 'vmd')
  await writeFile(configPath, JSON.stringify({
    motions: [
      {
        id: 'wave',
        displayName: 'Wave',
        format: 'vmd',
        path: motionPath,
        loop: false,
      },
    ],
  }))

  const config = await loadLocalConfig(configPath)
  assert.equal(config.motions?.length, 1)
  assert.equal(config.motions?.[0]?.id, 'wave')
  assert.equal(config.motions?.[0]?.entryFilePath, motionPath)

  // Rejects invalid motion formats or non-existent files
  await writeFile(configPath, JSON.stringify({
    motions: [{ id: 'bad', displayName: 'Bad', format: 'fbx', path: motionPath }],
  }))
  await assert.rejects(loadLocalConfig(configPath), /format|vmd/i)
})

test('local config parses startup generate presets and requires an ardy backend', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rayure-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const configPath = join(root, 'rayure.local.json')

  // Missing ardy is rejected when startupGenerate is present.
  await writeFile(configPath, JSON.stringify({
    motionSemantic: {
      startupGenerate: [{ id: 'wave.casual', prompt: 'casually wave' }],
    },
  }))
  await assert.rejects(loadLocalConfig(configPath), /ardy/i)

  await writeFile(configPath, JSON.stringify({
    motionSemantic: {
      startupGenerate: [
        { id: 'wave.casual', prompt: 'casually wave', numFrames: 40, numDenoisingSteps: 2, cfgWeight: 1.5 },
        { id: 'scratch.head', prompt: 'awkwardly scratch head' },
      ],
      ardy: {
        command: 'node',
        args: ['ardy-bridge.mjs'],
      },
    },
  }))
  const config = await loadLocalConfig(configPath)
  assert.equal(config.motionSemantic?.startupGenerate?.length, 2)
  assert.deepEqual(config.motionSemantic?.startupGenerate?.[0], {
    id: 'wave.casual',
    prompt: 'casually wave',
    numFrames: 40,
    numDenoisingSteps: 2,
    cfgWeight: 1.5,
  })
  assert.deepEqual(config.motionSemantic?.startupGenerate?.[1], {
    id: 'scratch.head',
    prompt: 'awkwardly scratch head',
  })

  // Invalid preset fields are rejected.
  for (const bad of [
    [],
    [{ id: 'bad id', prompt: 'x' }],
    [{ id: 'x', prompt: 'x', numFrames: 0 }],
    [{ id: 'x', prompt: 'x', numDenoisingSteps: 99 }],
    [{ id: 'x', prompt: 'x', cfgWeight: -1 }],
    [{ id: 'x', prompt: 'x', extra: true }],
  ]) {
    await writeFile(configPath, JSON.stringify({
      motionSemantic: {
        startupGenerate: bad,
        ardy: { command: 'node', args: ['ardy-bridge.mjs'] },
      },
    }))
    await assert.rejects(loadLocalConfig(configPath), /startupGenerate|array|identifier|integer|finite|fields/i)
  }
})

test('local config validates static scene entities and their ARDY coordinate transform', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rayure-scene-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const configPath = join(root, 'rayure.local.json')
  await writeFile(configPath, JSON.stringify({
    motionSemantic: {
      ardy: { command: 'node', args: ['ardy-bridge.mjs'] },
      scene: {
        transform: { origin: [10, 0, 10], scale: 0.5 },
        entities: [{ id: 'desk', position: [14, 2, 6], headingRadians: 1.5 }],
      },
    },
  }))
  const config = await loadLocalConfig(configPath)
  assert.deepEqual(config.motionSemantic?.scene, {
    transform: { origin: [10, 0, 10], scale: 0.5 },
    entities: [{ id: 'desk', position: [14, 2, 6], headingRadians: 1.5 }],
  })

  for (const scene of [
    { entities: [{ id: 'desk', position: [0, 0] }] },
    { entities: [{ id: 'desk', position: [0, 0, 0] }, { id: 'desk', position: [1, 0, 0] }] },
    { transform: { scale: 0 } },
    { entities: [{ id: 'desk', position: [0, 0, 0], extra: true }] },
  ]) {
    await writeFile(configPath, JSON.stringify({
      motionSemantic: { ardy: { command: 'node', args: ['ardy-bridge.mjs'] }, scene },
    }))
    await assert.rejects(loadLocalConfig(configPath), /scene|vector|duplicated|scale|fields/i)
  }
})

test('local config resolves opt-in simulated vision with safe defaults and action allowlist', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rayure-vision-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const configPath = join(root, 'rayure.local.json')
  await writeFile(configPath, JSON.stringify({
    vision: {
      enabled: true,
      command: process.execPath,
      args: ['bridge.js', '--simulate'],
      actions: { 'gesture.wave': 'wave.casual' },
    },
  }))
  const config = await loadLocalConfig(configPath)
  assert.deepEqual(config.vision, {
    enabled: true,
    command: process.execPath,
    args: ['bridge.js', '--simulate'],
    cameraIndex: 0,
    fps: 8,
    width: 640,
    height: 360,
    actions: { 'gesture.wave': 'wave.casual' },
  })
})

test('local config rejects unsafe or ambiguous vision settings', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rayure-vision-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const configPath = join(root, 'rayure.local.json')
  const invalidValues: unknown[] = [
    { vision: { enabled: 'yes', command: 'python', args: ['--simulate'] } },
    { vision: { enabled: true, command: 'python', args: [] } },
    { vision: { enabled: true, command: 'python', args: ['--simulate', '--fps'], fps: 0 } },
    { vision: { enabled: true, command: 'python', args: ['--simulate', '--model'] } },
    { vision: { enabled: true, command: 'python', args: ['--simulate'], actions: { unknown: 'wave' } } },
    { vision: { enabled: true, command: 'python', args: ['--simulate'], cameraIndex: 99 } },
  ]
  for (const value of invalidValues) {
    await writeFile(configPath, JSON.stringify(value))
    await assert.rejects(loadLocalConfig(configPath), /vision|enabled|modelPath|reserved|fps|action|camera/i, JSON.stringify(value))
  }
})

test('local config resolves opt-in speech and keeps ASR process settings explicit', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rayure-speech-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const configPath = join(root, 'rayure.local.json')
  await writeFile(configPath, JSON.stringify({
    speech: {
      enabled: true,
      agent: { endpoint: 'http://127.0.0.1:8123/agent', timeoutMs: 5000 },
      tts: { command: process.execPath, args: ['tts-bridge.js', '--simulate'], requestTimeoutMs: 5000 },
      asr: { command: process.execPath, args: ['speech-bridge.js', '--simulate'], startupTimeoutMs: 5000 },
    },
  }))
  const config = await loadLocalConfig(configPath)
  assert.deepEqual(config.speech, {
    enabled: true,
    agent: { endpoint: 'http://127.0.0.1:8123/agent', timeoutMs: 5000 },
    tts: { command: process.execPath, args: ['tts-bridge.js', '--simulate'], requestTimeoutMs: 5000 },
    asr: { command: process.execPath, args: ['speech-bridge.js', '--simulate'], startupTimeoutMs: 5000 },
  })
})

test('local config rejects unsafe speech process settings', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rayure-speech-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const configPath = join(root, 'rayure.local.json')
  for (const value of [
    { speech: { enabled: 'yes' } },
    { speech: { enabled: true, extra: true } },
    { speech: { enabled: true, agent: { endpoint: 'https://example.com/agent?secret=1' } } },
    { speech: { enabled: true, agent: { endpoint: 'https://example.com/agent', timeoutMs: 1 } } },
    { speech: { enabled: true, tts: { command: 'node', args: ['x'], requestTimeoutMs: 1 } } },
    { speech: { enabled: true, asr: { command: 'node', args: ['x'], startupTimeoutMs: 1 } } },
    { speech: { enabled: true, asr: { command: 'node', args: ['x'], cwd: 'relative' } } },
    { speech: { enabled: true, asr: { command: 'node', args: ['x'], extra: true } } },
  ]) {
    await writeFile(configPath, JSON.stringify(value))
    await assert.rejects(loadLocalConfig(configPath), /speech|enabled|timeout|absolute|fields/i, JSON.stringify(value))
  }
})
