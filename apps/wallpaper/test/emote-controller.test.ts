import assert from 'node:assert/strict'
import test from 'node:test'
import { EmoteController } from '../src/emote-controller.ts'
import { ExpressionController } from '../src/expression-controller.ts'
import { MotionController } from '../src/motion-controller.ts'

function createFakeMesh(): any {
  const influences = [0, 0]
  const dictionary = { 'まばたき': 0, '笑い': 1 }
  return {
    morphTargetInfluences: influences,
    morphTargetDictionary: dictionary,
  }
}

function createFakeMotionController(): { controller: MotionController, played: any[] } {
  const played: any[] = []
  const fakeLoader: any = {
    loadAnimation: async (url: string) => ({ url } as any),
  }
  const fakeModel: any = {
    setAnimation: () => undefined,
    clearAnimation: () => undefined,
  }
  const controller = new MotionController({ loader: fakeLoader })
  controller.bindModel(fakeModel)

  const originalPlay = controller.playMotion.bind(controller)
  controller.playMotion = async (descriptor: any, onFinished?: (() => void) | undefined) => {
    played.push(descriptor)
    return originalPlay(descriptor, onFinished)
  }

  return { controller, played }
}

test('EmoteController resolves preset motions and expressions', async (t) => {
  const mesh = createFakeMesh()
  const expression = new ExpressionController(mesh, { autoBlink: false })
  const { controller: motion, played } = createFakeMotionController()

  const emote = new EmoteController(motion, expression)
  t.after(() => emote.dispose())
  emote.updateCatalog([
    {
      id: 'greeting',
      displayName: 'Greeting',
      format: 'vmd',
      url: 'http://127.0.0.1:32145/assets/tok/greeting.vmd',
    },
  ])

  const result = await emote.playEmote({ emoteId: 'greet' })
  assert.equal(result, true)
  assert.equal(played.length, 1)
  assert.equal(played[0].id, 'greeting')
  // 表情应已设置为 smile
  expression.advance(0.3)
  assert.equal(mesh.morphTargetInfluences[1]! > 0.9, true)
})

test('EmoteController gracefully executes expression even if motion is absent', async (t) => {
  const mesh = createFakeMesh()
  const expression = new ExpressionController(mesh, { autoBlink: false })
  const { controller: motion, played } = createFakeMotionController()

  const emote = new EmoteController(motion, expression)
  t.after(() => emote.dispose())
  // 空 catalog
  const result = await emote.playEmote({ emoteId: 'cheer' })
  assert.equal(result, true)
  assert.equal(played.length, 0)
  expression.advance(0.3)
  assert.equal(mesh.morphTargetInfluences[1]! > 0.9, true)
})

test('EmoteController disposal cancels timers and catalog', async () => {
  const mesh = createFakeMesh()
  const expression = new ExpressionController(mesh)
  const { controller: motion } = createFakeMotionController()

  const emote = new EmoteController(motion, expression)
  emote.dispose()
  assert.equal(await emote.playEmote({ emoteId: 'greet' }), false)
})
