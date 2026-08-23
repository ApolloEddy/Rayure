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
