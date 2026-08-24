export interface ParameterCrossfade {
  startedAtMs: number
  durationMs: number
  values: ReadonlyMap<string, number>
}

export interface ParameterCrossfadeSample {
  value: number
  done: boolean
}

export function createParameterCrossfade(
  values: ReadonlyMap<string, number>,
  startedAtMs: number,
  durationMs: number,
): ParameterCrossfade | undefined {
  if (!Number.isFinite(startedAtMs) || !Number.isSafeInteger(durationMs) || durationMs <= 0) return undefined
  return { startedAtMs, durationMs, values }
}

export function sampleParameterCrossfade(
  crossfade: ParameterCrossfade,
  parameterId: string,
  target: number,
  nowMs: number,
): ParameterCrossfadeSample {
  if (!Number.isFinite(target) || !Number.isFinite(nowMs)) return { value: target, done: false }
  const alpha = Math.min(1, Math.max(0, (nowMs - crossfade.startedAtMs) / crossfade.durationMs))
  const source = crossfade.values.get(parameterId)
  if (source === undefined || !Number.isFinite(source)) return { value: target, done: alpha >= 1 }
  return {
    value: source + (target - source) * alpha,
    done: alpha >= 1,
  }
}
