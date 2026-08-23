import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadLocalConfig } from './local-config.ts'
import type { RayureLocalConfig } from './local-config.ts'
import { createMotionSemanticRuntime } from './motion-semantic-runtime.ts'
import type { MotionSemanticRuntime } from './motion-semantic-runtime.ts'
import { MotionGenerationController } from './motion-generation-controller.ts'
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

    const controller = createGenerationController(config, server, motionSemanticRuntime)
    if (controller !== undefined) {
      await controller.runStartup(config.motionSemantic?.startupGenerate ?? [])
      // Expose the live entry point so a future ASR/LLM behavior layer can call
      // submitIntent() at runtime; absent without a configured ARDY backend.
      ;(globalThis as { rayureMotionGeneration?: MotionGenerationController }).rayureMotionGeneration = controller
    }
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
 * Builds the live motion generation controller. It is only constructed when an
 * ARDY backend is configured (motion semantic generation is available); an
 * unconfigured process gets no controller and publishes nothing.
 */
function createGenerationController(
  config: RayureLocalConfig,
  server: CompanionServer,
  runtime: MotionSemanticRuntime,
): MotionGenerationController | undefined {
  if (config.motionSemantic?.ardy === undefined) return undefined
  const service = runtime.createGenerationService()
  return new MotionGenerationController({
    generate: async (intent, history) => {
      const result = await service.generate({
        cacheKey: intent.id,
        canonicalPrompt: intent.prompt,
        numFrames: intent.numFrames ?? 60,
        numDenoisingSteps: intent.numDenoisingSteps ?? 4,
        cfgWeight: intent.cfgWeight ?? 2,
        ...(intent.signal === undefined ? {} : { signal: intent.signal }),
        ...(history === undefined ? {} : { history }),
      })
      return result.motion
    },
    publish: input => server.publishMotion(input),
    onError: (cause, intentId) => {
      const message = cause instanceof Error ? cause.message : String(cause)
      process.stderr.write(`${JSON.stringify({ event: 'motion.generate.error', intentId, message })}\n`)
    },
  })
}

main().catch((cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause)
  process.stderr.write(`${JSON.stringify({ event: 'companion.error', message })}\n`)
  process.exitCode = 1
})
