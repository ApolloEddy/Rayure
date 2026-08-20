import assert from 'node:assert/strict'
import test from 'node:test'

import { parseLive2dMotionCatalog } from '../src/live2d-motion-catalog.ts'

test('Live2D motion catalog preserves model3 group/index and creates safe ids', () => {
  const catalog = parseLive2dMotionCatalog({
    Version: 3,
    FileReferences: {
      Motions: {
        Idle: [
          { File: 'motions/idle-01.motion3.json', FadeInTime: 0.5 },
          { File: 'motions/idle-02.motion3.json', FadeOutTime: 0.5 },
        ],
        'Tap Body': [
          { File: 'motions/tap.motion3.json' },
        ],
        'Tap-Body': [
          { File: 'motions/tap-alt.motion3.json' },
        ],
      },
    },
  })

  assert.deepEqual(catalog, [
    {
      id: 'live2d-Idle-0',
      displayName: 'Idle 1',
      group: 'Idle',
      index: 0,
      file: 'motions/idle-01.motion3.json',
    },
    {
      id: 'live2d-Idle-1',
      displayName: 'Idle 2',
      group: 'Idle',
      index: 1,
      file: 'motions/idle-02.motion3.json',
    },
    {
      id: 'live2d-Tap-Body-0',
      displayName: 'Tap Body 1',
      group: 'Tap Body',
      index: 0,
      file: 'motions/tap.motion3.json',
    },
    {
      id: 'live2d-Tap-Body-0-1',
      displayName: 'Tap-Body 1',
      group: 'Tap-Body',
      index: 0,
      file: 'motions/tap-alt.motion3.json',
    },
  ])
})

test('Live2D motion catalog rejects traversal, unsupported files and invalid fade values', () => {
  const invalidValues: unknown[] = [
    {
      Version: 3,
      FileReferences: { Motions: { Idle: [{ File: '../idle.motion3.json' }] } },
    },
    {
      Version: 3,
      FileReferences: { Motions: { Idle: [{ File: 'idle.vmd' }] } },
    },
    {
      Version: 3,
      FileReferences: { Motions: { Idle: [{ File: 'idle.motion3.json', FadeInTime: -1 }] } },
    },
  ]

  for (const value of invalidValues) {
    assert.throws(() => parseLive2dMotionCatalog(value), /motion|path|duration|fade/i)
  }
})
