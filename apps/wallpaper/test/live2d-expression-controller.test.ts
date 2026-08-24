import assert from 'node:assert/strict'
import test from 'node:test'

import {
  Live2dExpressionController,
  normalizeLive2dExpressionKey,
  resolveLive2dExpression,
} from '../src/live2d/expression-controller.ts'
import { selectLive2dInteractionMotion } from '../src/live2d/native-surface.ts'

test('Live2D pointer interaction chooses the model-specific head/body motion group', () => {
  const motions = [
    { id: 'head', displayName: 'touch head', format: 'live2d' as const, url: 'http://127.0.0.1:32145/assets/token/touch_head.motion3.json', group: 'touch_head', index: 0 },
    { id: 'body', displayName: 'touch body', format: 'live2d' as const, url: 'http://127.0.0.1:32145/assets/token/touch_body.motion3.json', group: 'touch_body', index: 0 },
  ]

  assert.equal(selectLive2dInteractionMotion(motions, 0.2)?.id, 'head')
  assert.equal(selectLive2dInteractionMotion(motions, 0.7)?.id, 'body')
})

test('Live2D expression resolver matches filenames, paths and semantic aliases', () => {
  const expressions = [
    'expressions/Smile.exp3.json',
    'expressions/blink_left.exp3.json',
    'expression_surprised.exp3.json',
  ]

  assert.equal(normalizeLive2dExpressionKey('Expressions\\Smile.exp3.json'), 'smile')
  assert.equal(resolveLive2dExpression('Smile.exp3.json', expressions), expressions[0])
  assert.equal(resolveLive2dExpression('开心', expressions), expressions[0])
  assert.equal(resolveLive2dExpression('expression_smile', expressions), expressions[0])
  assert.equal(resolveLive2dExpression('surprise', expressions), expressions[2])
  assert.equal(resolveLive2dExpression('blink_left', expressions), expressions[1])
})

test('Live2D expression resolver rejects an unknown name instead of selecting an arbitrary asset', () => {
  assert.equal(resolveLive2dExpression('dance', ['smile.exp3.json', 'sad.exp3.json']), undefined)
  assert.equal(resolveLive2dExpression('   ', ['smile.exp3.json']), undefined)
})

test('Live2D expression controller gates zero weight, starts native expressions and resets safely', () => {
  const started: string[] = []
  let stopped = 0
  const controller = new Live2dExpressionController()
  controller.bindModel({
    getExpressions: () => ['expressions/smile.exp3.json'],
    setExpression: expression => started.push(expression),
    stopExpressions: () => { stopped += 1 },
  })

  assert.equal(controller.setExpression('smile', 0.75, 250), true)
  assert.deepEqual(started, ['expressions/smile.exp3.json'])
  assert.equal(controller.activeExpressionId, 'expressions/smile.exp3.json')
  assert.equal(controller.setExpression('smile', 0), true)
  assert.equal(controller.activeExpressionId, undefined)
  assert.equal(stopped, 1)
  assert.equal(controller.setExpression('missing', 1), false)
})
