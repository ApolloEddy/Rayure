import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadLocalConfig } from './local-config.ts'
import type { RayureLocalConfig, RayureMotionGeneratePreset } from './local-config.ts'
import { createMotionSemanticRuntime } from './motion-semantic-runtime.ts'
import type { MotionSemanticRuntime } from './motion-semantic-runtime.ts'
import { createCompanionServer } from './server.ts'
import type { CompanionServer } from './server.ts'

const DEFAULT_PORT = 32145

function readPort(): number {
  const raw = process.env.RAYURE_COMPANION_PORT
  if (raw === undefined) return DEFAULT_PORT
  if (!/^[0-9]{4,5}$/u.test(raw)) throw new Error('RAYURE_COMPANION_PORT must be an integer from 1024 through 65535')
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error('RAYURE_COMPANION_PORT must be an integer from 1024 through 65535')
  }
  return port
}

async function main(): Promise<void> {
  const explicitConfigPath = readExplicitConfigPath()
  const configPath = explicitConfigPath ?? fileURLToPath(new URL('../../../rayure.local.json', import.meta.url))
  const config = await loadLocalConfig(configPath, { optional: explicitConfigPath === undefined })
  const motionSemanticRuntime = await createMotionSemanticRuntime(config.motionSemantic)
  const server = createCompanionServer({
    port: readPort(),
    ...(config.model === undefined ? {} : { model: config.model }),
    ...(config.motions === undefined ? {} : { motions: config.motions }),
  })
  try {
    const address = await server.start()
    process.stdout.write(`${JSON.stringify({
      event: 'companion.ready',
      ...address,
      modelAvailable: config.model !== undefined,
      motionSemanticCacheEntries: motionSemanticRuntime.cache.size,
      motionSemanticEncoderAvailable: motionSemanticRuntime.resolver !== undefined,
      ardyAvailable: motionSemanticRuntime.ardy !== undefined,
    })}\n`)

    let stopping = false
    const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
      if (stopping) return
      stopping = true
      process.stderr.write(`${JSON.stringify({ event: 'companion.stopping', signal })}\n`)
      await Promise.all([server.stop(), motionSemanticRuntime.close()])
    }

    process.once('SIGINT', () => void shutdown('SIGINT'))
    process.once('SIGTERM', () => void shutdown('SIGTERM'))

    await runStartupGeneration(config, server, motionSemanticRuntime)
  }
  catch (cause) {
    await motionSemanticRuntime.close()
    throw cause
  }
}

function readExplicitConfigPath(): string | undefined {
  const raw = process.env.RAYURE_LOCAL_CONFIG
  if (raw === undefined) return undefined
  if (raw.length < 1 || raw.trim() !== raw || raw.includes('\u0000') || !isAbsolute(raw)) {
    throw new Error('RAYURE_LOCAL_CONFIG must be an absolute path without surrounding whitespace')
  }
  return raw
}

/**
 * Runs configured startup motion presets, publishing each generated Canonical
 * Motion to connected renderers so the generation -> publish -> play loop is
 * exercised without any UI. Failures are fatal to the process: a configured
 * generation that cannot run should surface at startup, not silently no-op.
 */
async function runStartupGeneration(
  config: RayureLocalConfig,
  server: CompanionServer,
  runtime: MotionSemanticRuntime,
): Promise<void> {
  const presets = config.motionSemantic?.startupGenerate
  if (presets === undefined || presets.length === 0) return
  const service = runtime.createGenerationService()
  for (const preset of presets) {
    const result = await service.generate({
      cacheKey: preset.id,
      canonicalPrompt: preset.prompt,
      numFrames: preset.numFrames ?? 60,
      numDenoisingSteps: preset.numDenoisingSteps ?? 4,
      cfgWeight: preset.cfgWeight ?? 2,
    })
    server.publishMotion({
      id: preset.id,
      displayName: preset.prompt,
      motion: result.motion,
    })
  }
}

main().catch((cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause)
  process.stderr.write(`${JSON.stringify({ event: 'companion.error', message })}\n`)
  process.exitCode = 1
})
