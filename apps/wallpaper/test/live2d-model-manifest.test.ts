import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import {
  collectLive2dAssetPaths,
  hasLive2dMoc3Header,
  parseLive2dDisplayInfo,
  parseLive2dModel3,
  scanLive2dRigProfile,
} from '../src/live2d/model-manifest.ts'
import { STANDARD_LIVE2D_RIG_PROFILE } from '../src/live2d/rig-profile.ts'

const MODEL3_FIXTURE = {
  Version: 3,
  FileReferences: {
    Moc: 'Hiyori.moc3',
    Textures: ['Hiyori.2048/texture_00.png', 'Hiyori.2048/texture_01.png'],
    Physics: 'Hiyori.physics3.json',
    Pose: 'Hiyori.pose3.json',
    UserData: 'Hiyori.userdata3.json',
    DisplayInfo: 'Hiyori.cdi3.json',
    Motions: {
      Idle: [
        { File: 'motions/Hiyori_m01.motion3.json', FadeInTime: 0.5, FadeOutTime: 0.5 },
      ],
      TapBody: [
        { File: 'motions/Hiyori_m04.motion3.json' },
      ],
    },
  },
  Groups: [
    { Target: 'Parameter', Name: 'LipSync', Ids: ['ParamMouthOpenY'] },
  ],
  HitAreas: [
    { Id: 'HitArea', Name: 'Body' },
  ],
}

test('Live2D model3 manifest validates relative assets and collects motion references', () => {
  const manifest = parseLive2dModel3(MODEL3_FIXTURE, 'hiyori-debug')
  assert.equal(manifest.id, 'hiyori-debug')
  assert.deepEqual(manifest.fileReferences.motions.Idle?.[0], {
    file: 'motions/Hiyori_m01.motion3.json',
    fadeInTime: 0.5,
    fadeOutTime: 0.5,
  })
  assert.deepEqual(collectLive2dAssetPaths(manifest), [
    'Hiyori.2048/texture_00.png',
    'Hiyori.2048/texture_01.png',
    'Hiyori.cdi3.json',
    'Hiyori.moc3',
    'Hiyori.physics3.json',
    'Hiyori.pose3.json',
    'Hiyori.userdata3.json',
    'motions/Hiyori_m01.motion3.json',
    'motions/Hiyori_m04.motion3.json',
  ])
})

test('Live2D display info scans the standard Rayure rig parameters', () => {
  const parameters = parseLive2dDisplayInfo({
    Version: 3,
    Parameters: [
      ...STANDARD_LIVE2D_RIG_PROFILE.parameters.map(binding => ({ Id: binding.parameterId })),
      { Id: 'ParamCheek', GroupId: 'ParamGroupFace', Name: 'Cheek' },
    ],
  })
  const scan = scanLive2dRigProfile(parameters)
  assert.deepEqual(scan.missingParameterIds, [])
  assert.equal(scan.matchedParameterIds.length, STANDARD_LIVE2D_RIG_PROFILE.parameters.length)
  assert.equal(scan.availableParameterCount, 12)
})

test('Live2D manifest rejects traversal, duplicate paths, and invalid fade durations', () => {
  assert.throws(() => parseLive2dModel3({
    ...MODEL3_FIXTURE,
    FileReferences: {
      ...MODEL3_FIXTURE.FileReferences,
      Textures: ['../texture.png'],
    },
  }), /relative asset path/u)

  assert.throws(() => parseLive2dModel3({
    ...MODEL3_FIXTURE,
    FileReferences: {
      ...MODEL3_FIXTURE.FileReferences,
      Textures: ['texture.png', 'texture.png'],
    },
  }), /duplicate paths/u)

  assert.throws(() => parseLive2dModel3({
    ...MODEL3_FIXTURE,
    FileReferences: {
      ...MODEL3_FIXTURE.FileReferences,
      Motions: { Idle: [{ File: 'idle.motion3.json', FadeInTime: -1 }] },
    },
  }), /duration/u)
})

test('local Hiyori sample, when prepared, contains the full standard parameter set and files', () => {
  const root = join(process.cwd(), 'scratch', 'live2d-samples', 'Hiyori')
  const modelPath = join(root, 'Hiyori.model3.json')
  const displayInfoPath = join(root, 'Hiyori.cdi3.json')
  if (!existsSync(modelPath) || !existsSync(displayInfoPath)) return

  const manifest = parseLive2dModel3(JSON.parse(readFileSync(modelPath, 'utf8')), 'hiyori-sample')
  const parameters = parseLive2dDisplayInfo(JSON.parse(readFileSync(displayInfoPath, 'utf8')))
  const scan = scanLive2dRigProfile(parameters)
  assert.deepEqual(scan.missingParameterIds, [])
  for (const relativePath of collectLive2dAssetPaths(manifest)) {
    assert.equal(existsSync(join(root, relativePath)), true, relativePath)
  }
  assert.equal(hasLive2dMoc3Header(new Uint8Array(readFileSync(join(root, manifest.fileReferences.moc)))), true)
})
