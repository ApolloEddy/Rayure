import assert from 'node:assert/strict'
import test from 'node:test'

import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Texture } from 'three'

import {
  MmdModelHost,
  disposeMmdModel,
  type LoadableMmdModel,
  type MmdModelLoaderLike,
} from '../src/mmd-model-host.ts'

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

function createFakeModel(): LoadableMmdModel & { runtimeDisposed: boolean, updateCalls: number[] } {
  const root = new Group()
  root.add(new Mesh(new BoxGeometry(2, 4, 2), new MeshBasicMaterial()))
  const model = {
    root,
    runtimeDisposed: false,
    updateCalls: [] as number[],
    runtime: {
      dispose(): void {
        model.runtimeDisposed = true
      },
    },
    update(seconds: number): void {
      model.updateCalls.push(seconds)
    },
  }
  return model
}

function descriptor(id: string, suffix = id) {
  return {
    id,
    displayName: id,
    format: 'pmx' as const,
    url: `http://127.0.0.1:32145/assets/0123456789abcdef/${suffix}.pmx`,
  }
}

test('a valid model is fitted and atomically committed to the mount', async () => {
  const mount = new Group()
  const model = createFakeModel()
  const loader: MmdModelLoaderLike = { loadModel: async () => model }
  const host = new MmdModelHost(mount, { loader, targetHeight: 3.2, floorY: -1.6 })

  assert.equal(await host.load(descriptor('first')), 'committed')
  assert.equal(host.activeModelId, 'first')
  assert.equal(mount.children.length, 1)
  assert.equal(mount.children[0]?.scale.x, 0.8)
  assert.equal(mount.children[0]?.position.y, 0)

  host.advance(0.1)
  host.advance(0.2)
  assert.deepEqual(model.updateCalls, [0.1, 0.2])
})

test('a slow superseded load is disposed and cannot replace the newest model', async () => {
  const mount = new Group()
  const slow = deferred<LoadableMmdModel>()
  const fast = deferred<LoadableMmdModel>()
  const slowModel = createFakeModel()
  const fastModel = createFakeModel()
  const loader: MmdModelLoaderLike = {
    loadModel: (url) => url.endsWith('/slow.pmx') ? slow.promise : fast.promise,
  }
  const host = new MmdModelHost(mount, { loader })

  const slowLoad = host.load(descriptor('slow'))
  const fastLoad = host.load(descriptor('fast'))
  fast.resolve(fastModel)
  assert.equal(await fastLoad, 'committed')
  slow.resolve(slowModel)
  assert.equal(await slowLoad, 'superseded')

  assert.equal(host.activeModelId, 'fast')
  assert.equal(mount.children[0]?.children.includes(fastModel.root), true)
  assert.equal(slowModel.runtimeDisposed, true)
  assert.equal(fastModel.runtimeDisposed, false)
})

test('failed replacements preserve the current model and duplicate announcements do not reload', async () => {
  const mount = new Group()
  const first = createFakeModel()
  let loadCalls = 0
  const loader: MmdModelLoaderLike = {
    async loadModel(url) {
      loadCalls += 1
      if (url.endsWith('/broken.pmx')) throw new Error('network failure containing a private URL')
      return first
    },
  }
  const host = new MmdModelHost(mount, { loader })

  assert.equal(await host.load(descriptor('first')), 'committed')
  assert.equal(await host.load(descriptor('first')), 'unchanged')
  assert.equal(await host.load(descriptor('broken')), 'failed')
  assert.equal(loadCalls, 2)
  assert.equal(host.activeModelId, 'first')
  assert.equal(first.runtimeDisposed, false)
})

test('dispose aborts ownership and disposes a model that resolves late', async () => {
  const mount = new Group()
  const pending = deferred<LoadableMmdModel>()
  const model = createFakeModel()
  const host = new MmdModelHost(mount, { loader: { loadModel: () => pending.promise } })

  const load = host.load(descriptor('late'))
  host.dispose()
  pending.resolve(model)
  assert.equal(await load, 'superseded')
  assert.equal(model.runtimeDisposed, true)
  assert.equal(mount.children.length, 0)
})

test('models without finite visible bounds fail closed', async () => {
  const emptyModel = createFakeModel()
  emptyModel.root.clear()
  const host = new MmdModelHost(new Group(), { loader: { loadModel: async () => emptyModel } })
  assert.equal(await host.load(descriptor('empty')), 'failed')
  assert.equal(emptyModel.runtimeDisposed, true)
  assert.equal(host.activeModelId, undefined)
})

test('resource disposal releases loader-owned textures but preserves shared fallbacks', () => {
  const model = createFakeModel()
  const mesh = model.root.children[0]
  assert.ok(mesh instanceof Mesh)
  assert.ok(mesh.material instanceof MeshBasicMaterial)
  const ownedTexture = new Texture()
  ownedTexture.userData.mmdTextureOwnership = 'loader'
  const sharedTexture = new Texture()
  sharedTexture.userData.mmdFallbackToonGradient = true
  mesh.material.map = ownedTexture
  mesh.material.alphaMap = sharedTexture
  let ownedDisposals = 0
  let sharedDisposals = 0
  ownedTexture.addEventListener('dispose', () => { ownedDisposals += 1 })
  sharedTexture.addEventListener('dispose', () => { sharedDisposals += 1 })

  disposeMmdModel(model)
  assert.equal(ownedDisposals, 1)
  assert.equal(sharedDisposals, 0)
})

test('MmdModelHost delegates motions and expressions to active controllers', async () => {
  const mount = new Group()
  const model = createFakeModel()
  const mesh = model.root.children[0]
  if (mesh instanceof Mesh) {
    mesh.morphTargetDictionary = { まばたき: 0, 笑い: 1 }
    mesh.morphTargetInfluences = [0, 0]
  }

  let boundAnimation: any = null
  let clearedAnimation = false
  const animModel: LoadableMmdModel = {
    ...model,
    setAnimation(anim) {
      boundAnimation = anim
    },
    clearAnimation() {
      clearedAnimation = true
    },
  }

  const loader: MmdModelLoaderLike = {
    loadModel: async () => animModel,
    loadAnimation: async (url: string) => ({ source: url, animation: {} as any }),
  }
  const host = new MmdModelHost(mount, { loader })
  await host.load(descriptor('test-model'))

  // 1. 测试表情触发与推进
  host.setExpression('smile', 0.9, 0)
  host.advance(0.1)
  assert.equal(host.expression?.getMorphWeight('smile'), 0.9)

  // 2. 测试动作播放与停止
  const playResult = await host.playMotion({
    id: 'test-motion',
    displayName: 'Test Motion',
    format: 'vmd',
    url: 'http://127.0.0.1:32145/assets/0123456789abcdef/test.vmd',
  })
  assert.equal(playResult, true)
  assert.ok(boundAnimation !== null)
  assert.equal(host.motion.activeMotionId, 'test-motion')

  host.stopMotion('test-motion')
  assert.equal(clearedAnimation, true)
  assert.equal(host.motion.isPlaying, false)
})

