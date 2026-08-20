import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_WALLPAPER_SETTINGS,
  parseAccentColor,
  parseBoolean,
  parseFps,
  parseModelScale,
  parsePort,
} from '../src/config.ts'

test('port accepts integers in the unprivileged TCP range', () => {
  assert.equal(parsePort('32145'), 32145)
  assert.equal(parsePort(1024), 1024)
  assert.equal(parsePort(65535), 65535)
})

test('port rejects blanks, fractions, coercion tricks and out-of-range values', () => {
  for (const value of ['', '  ', '32145x', '1e4', 32145.5, 0, 1023, 65536, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(parsePort(value), undefined, String(value))
  }
})

test('FPS is bounded and rejects invalid rapid-update values', () => {
  assert.equal(parseFps(1), 1)
  assert.equal(parseFps(60), 60)
  assert.equal(parseFps(240), 240)
  for (const value of [0, -1, 241, 59.5, '60', Number.NaN]) {
    assert.equal(parseFps(value), undefined, String(value))
  }
})

test('Wallpaper Engine colors are clamped only after strict triplet validation', () => {
  assert.deepEqual(parseAccentColor('0.20 0.65 1.00'), { r: 51, g: 166, b: 255 })
  assert.equal(parseAccentColor(''), undefined)
  assert.equal(parseAccentColor('0.2 0.3'), undefined)
  assert.equal(parseAccentColor('0.2 0.3 0.4 0.5'), undefined)
  assert.equal(parseAccentColor('NaN 0.3 0.4'), undefined)
  assert.equal(parseAccentColor('-0.1 0.3 0.4'), undefined)
  assert.equal(parseAccentColor('0.1 0.3 1.1'), undefined)
})

test('boolean and model scale properties reject coercion and out-of-range updates', () => {
  assert.equal(parseBoolean(true), true)
  assert.equal(parseBoolean(false), false)
  for (const value of [0, 1, 'true', '', null, undefined]) {
    assert.equal(parseBoolean(value), undefined, String(value))
  }

  assert.equal(parseModelScale(25), 0.25)
  assert.equal(parseModelScale(100), 1)
  assert.equal(parseModelScale(200), 2)
  for (const value of [24, 201, 99.5, '100', Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(parseModelScale(value), undefined, String(value))
  }
})

test('defaults remain safe for a missing Wallpaper Engine API', () => {
  assert.deepEqual(DEFAULT_WALLPAPER_SETTINGS, {
    companionPort: 32145,
    fps: 30,
    accent: { r: 103, g: 232, b: 249 },
    modelScale: 1,
    showStatus: true,
  })
})
