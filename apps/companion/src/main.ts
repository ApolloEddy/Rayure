import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadLocalConfig } from './local-config.ts'
import { createCompanionServer } from './server.ts'

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
  const server = createCompanionServer({
    port: readPort(),
    ...(config.model === undefined ? {} : { model: config.model }),
    ...(config.motions === undefined ? {} : { motions: config.motions }),
  })
  const address = await server.start()
  process.stdout.write(`${JSON.stringify({
    event: 'companion.ready',
    ...address,
    modelAvailable: config.model !== undefined,
  })}\n`)

  let stopping = false
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return
    stopping = true
    process.stderr.write(`${JSON.stringify({ event: 'companion.stopping', signal })}\n`)
    await server.stop()
  }

  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
}

function readExplicitConfigPath(): string | undefined {
  const raw = process.env.RAYURE_LOCAL_CONFIG
  if (raw === undefined) return undefined
  if (raw.length < 1 || raw.trim() !== raw || raw.includes('\u0000') || !isAbsolute(raw)) {
    throw new Error('RAYURE_LOCAL_CONFIG must be an absolute path without surrounding whitespace')
  }
  return raw
}

main().catch((cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause)
  process.stderr.write(`${JSON.stringify({ event: 'companion.error', message })}\n`)
  process.exitCode = 1
})
