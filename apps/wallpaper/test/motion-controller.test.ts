import assert from 'node:assert/strict'
import test from 'node:test'

import { MotionController } from '../src/motion-controller.ts'
import type { LoadableMmdAnimationHost, MmdMotionLoaderLike } from '../src/motion-controller.ts'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(cause: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void
  let rejectPromise!: (cause: unknown) => void
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

test('MotionController loads, binds and stops animations', async () => {
  let boundAnim: any = null
  let cleared = false
  const mockModel: LoadableMmdAnimationHost = {
    setAnimation(anim) {
      boundAnim = anim
    },
    clearAnimation() {
      cleared = true
    },
  }

  let endReported: string | undefined
  const loader: MmdMotionLoaderLike = {
    async loadAnimation(source) {
      return { source, animation: { name: 'test-vmd' } as any }
    },
  }

  const controller = new MotionController({
    loader,
    onMotionEnd: (id) => {
      endReported = id
    },
  })
  controller.bindModel(mockModel)

  const played = await controller.playMotion({
    id: 'motion-1',
    displayName: 'Motion 1',
    format: 'vmd',
    url: 'http://127.0.0.1:32145/assets/0123456789abcdef/m1.vmd',
  })

  assert.equal(played, true)
  assert.equal(controller.isPlaying, true)
  assert.equal(controller.activeMotionId, 'motion-1')
  assert.equal(boundAnim?.animation.name, 'test-vmd')

  controller.stopMotion('motion-1')
  assert.equal(controller.isPlaying, false)
  assert.equal(controller.activeMotionId, undefined)
  assert.equal(cleared, true)
  assert.equal(endReported, 'motion-1')
})

test('MotionController prevents slow superseded motions from overwriting new ones', async () => {
  const slow = deferred<any>()
  const fast = deferred<any>()
  let lastBoundAnim: any = null

  const mockModel: LoadableMmdAnimationHost = {
    setAnimation(anim) {
      lastBoundAnim = anim
    },
  }

  const loader: MmdMotionLoaderLike = {
    loadAnimation: (url) => url.includes('slow') ? slow.promise : fast.promise,
  }

  const controller = new MotionController({ loader })
  controller.bindModel(mockModel)

  const slowPromise = controller.playMotion({
    id: 'slow',
    displayName: 'Slow',
    format: 'vmd',
    url: 'http://127.0.0.1:32145/assets/0123456789abcdef/slow.vmd',
  })
  const fastPromise = controller.playMotion({
    id: 'fast',
    displayName: 'Fast',
    format: 'vmd',
    url: 'http://127.0.0.1:32145/assets/0123456789abcdef/fast.vmd',
  })

  fast.resolve({ animation: { name: 'fast' } })
  assert.equal(await fastPromise, true)
  assert.equal(controller.activeMotionId, 'fast')
  assert.equal(lastBoundAnim.animation.name, 'fast')

  slow.resolve({ animation: { name: 'slow' } })
  assert.equal(await slowPromise, false)
  assert.equal(controller.activeMotionId, 'fast')
  assert.equal(lastBoundAnim.animation.name, 'fast')
})
