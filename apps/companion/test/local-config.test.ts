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

