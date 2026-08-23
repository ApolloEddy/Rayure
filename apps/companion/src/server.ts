import { randomBytes, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { Duplex } from 'node:stream'

import {
  MAX_WIRE_MESSAGE_BYTES,
  ProtocolValidationError,
  createServerError,
  createServerModelAvailable,
  createServerMotionCatalog,
  createServerMotionPublished,
  createServerWelcome,
  parseClientMessage,
  serializeWireMessage,
  validateCanonicalMotion,
} from '@rayure/protocol'
import type { CanonicalMotion, Live2dMotionDescriptor, MotionDescriptor } from '@rayure/protocol'
import { WebSocket, WebSocketServer } from 'ws'
import type { RawData } from 'ws'

import { readLive2dMotionCatalog } from './live2d-motion-catalog.ts'
import type { PreparedLive2dMotion } from './live2d-motion-catalog.ts'
import type { CompanionModelSource, CompanionMotionSource } from './model-source.ts'

const LOOPBACK_HOST = '127.0.0.1' as const
const DEFAULT_PORT = 32145
const DEFAULT_HELLO_TIMEOUT_MS = 5_000
const MAX_ASSET_BYTES = 256 * 1024 * 1024
const ASSET_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u
const ALLOWED_ASSET_EXTENSIONS = new Set([
  '.bmp',
  '.dds',
  '.gif',
  '.jpeg',
  '.jpg',
  '.json',
  '.moc3',
  '.pmx',
  '.png',
  '.spa',
  '.sph',
  '.tga',
  '.vmd',
  '.webp',
])

export interface CompanionServerOptions {
  port?: number
  helloTimeoutMs?: number
  now?: () => number
  createId?: () => string
  createAssetToken?: () => string
  model?: CompanionModelSource
  motions?: readonly CompanionMotionSource[]
}

export interface CompanionServerAddress {
  host: typeof LOOPBACK_HOST
  port: number
}

export interface CompanionServerSnapshot {
  phase: 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'error'
  connectedClients: number
  modelAvailable: boolean
  address?: CompanionServerAddress
  error?: string
}

export interface CompanionServer {
  start(): Promise<CompanionServerAddress>
  stop(): Promise<void>
  snapshot(): CompanionServerSnapshot
  /**
   * Publishes a generated Canonical Motion as a tokenized memory resource so
   * the renderer can fetch the large frame data over the loopback asset
   * gateway instead of the 16 KiB websocket. Returns the descriptor the
   * renderer should consume once it is announced via `motion.published`.
   */
  publishMotion(input: {
    id: string
    displayName: string
    motion: CanonicalMotion
    loop?: boolean
  }): MotionDescriptor
}

interface PreparedAsset {
  rootPath: string
  entryFileName: string
  assetToken: string
}

interface PreparedGeneratedMotion {
  kind: 'generated'
  assetToken: string
  entryFileName: string
  content: Buffer
  displayName: string
  motionId: string
  loop: boolean
}

interface PreparedModel extends PreparedAsset {
  source: CompanionModelSource
  live2dMotions: readonly PreparedLive2dMotion[]
}

interface PreparedMotion extends PreparedAsset {
  source: CompanionMotionSource
}

export function createCompanionServer(options: CompanionServerOptions = {}): CompanionServer {
  const port = requirePort(options.port ?? DEFAULT_PORT)
  const helloTimeoutMs = requireHelloTimeout(options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS)
  const now = options.now ?? Date.now
  const createId = options.createId ?? randomUUID
  const createAssetToken = options.createAssetToken ?? (() => randomBytes(32).toString('hex'))

  let phase: CompanionServerSnapshot['phase'] = 'idle'
  let address: CompanionServerAddress | undefined
  let error: string | undefined
  let httpServer: HttpServer | undefined
  let webSocketServer: WebSocketServer | undefined
  let preparedModel: PreparedModel | undefined
  let preparedMotions: readonly PreparedMotion[] = []
  const assetTokenMap = new Map<string, PreparedAsset>()
  const generatedTokenMap = new Map<string, PreparedGeneratedMotion>()
  let startPromise: Promise<CompanionServerAddress> | undefined
  let stopPromise: Promise<void> | undefined
  const welcomedClients = new Set<WebSocket>()

  async function start(): Promise<CompanionServerAddress> {
    if (address && phase === 'running') return address
    if (startPromise) return startPromise
    if (phase === 'stopping') throw new Error('Companion server is stopping')

    phase = 'starting'
    error = undefined
    startPromise = startServer()
    try {
      return await startPromise
    }
    finally {
      startPromise = undefined
    }
  }

  async function startServer(): Promise<CompanionServerAddress> {
    let nextHttpServer: HttpServer | undefined
    let nextWebSocketServer: WebSocketServer | undefined
    try {
      assetTokenMap.clear()
      generatedTokenMap.clear()
      preparedModel = options.model === undefined
        ? undefined
        : await prepareModel(options.model, createAssetToken())
      if (preparedModel) {
        assetTokenMap.set(preparedModel.assetToken, preparedModel)
      }

      if (options.motions && options.motions.length > 0) {
        const motions: PreparedMotion[] = []
        for (const motion of options.motions) {
          const prepared = await prepareMotion(motion, createAssetToken())
          motions.push(prepared)
          assetTokenMap.set(prepared.assetToken, prepared)
        }
        preparedMotions = motions
      }
      else {
        preparedMotions = []
      }

      const createdHttpServer = createServer((request, response) => {
        void handleHttpRequest(request, response, assetTokenMap, generatedTokenMap)
      })
      const createdWebSocketServer = new WebSocketServer({
        noServer: true,
        maxPayload: MAX_WIRE_MESSAGE_BYTES,
        perMessageDeflate: false,
        clientTracking: true,
      })
      nextHttpServer = createdHttpServer
      nextWebSocketServer = createdWebSocketServer
      httpServer = createdHttpServer
      webSocketServer = createdWebSocketServer

      createdHttpServer.on('upgrade', (request, socket, head) => {
        handleUpgrade(createdWebSocketServer, request, socket, head)
      })
      createdWebSocketServer.on('connection', socket => handleConnection(socket))

      await listen(createdHttpServer, port)
      const bound = createdHttpServer.address()
      if (!bound || typeof bound === 'string') throw new Error('Companion server did not expose a TCP address')
      address = toAddress(bound)
      phase = 'running'
      createdHttpServer.on('error', onRuntimeError)
      createdWebSocketServer.on('error', onRuntimeError)
      return address
    }
    catch (cause) {
      phase = 'error'
      error = toErrorMessage(cause)
      address = undefined
      preparedModel = undefined
      preparedMotions = []
      assetTokenMap.clear()
      generatedTokenMap.clear()
      webSocketServer = undefined
      httpServer = undefined
      await cleanupFailedStart(nextHttpServer, nextWebSocketServer)
      throw cause
    }
  }

  function handleUpgrade(
    server: WebSocketServer,
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    const pathname = parseRequestUrl(request)?.pathname
    if (pathname !== '/ws') {
      rejectUpgrade(socket, 404, 'Not Found')
      return
    }
    if (!isAllowedBrowserOrigin(request.headers.origin)) {
      rejectUpgrade(socket, 403, 'Forbidden')
      return
    }
    server.handleUpgrade(request, socket, head, upgraded => server.emit('connection', upgraded, request))
  }

  function handleConnection(socket: WebSocket): void {
    let welcomed = false
    const helloTimer = setTimeout(() => {
      if (welcomed || socket.readyState !== WebSocket.OPEN) return
      sendErrorAndClose(socket, 'hello_timeout', 'Client hello was not received in time', 1008)
    }, helloTimeoutMs)

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        clearTimeout(helloTimer)
        socket.close(1003, 'Binary messages are not supported')
        return
      }

      let message
      try {
        message = parseClientMessage(toText(data))
      }
      catch (cause) {
        clearTimeout(helloTimer)
        const detail = cause instanceof ProtocolValidationError ? cause.message : 'Message parsing failed'
        sendErrorAndClose(socket, 'invalid_message', detail, 1008)
        return
      }

      if (welcomed) {
        sendErrorAndClose(socket, 'duplicate_hello', 'Client hello has already completed', 1008, message.id)
        return
      }

      welcomed = true
      clearTimeout(helloTimer)
      try {
        const outbound = [serializeWireMessage(createServerWelcome({
          id: createId(),
          replyTo: message.id,
          connectionId: createId(),
          serverTimeMs: now(),
        }))]

        const model = preparedModel
        const boundAddress = address
        if (model && boundAddress) {
          const entryUrl = createAssetUrl(boundAddress, model)
          outbound.push(serializeWireMessage(createServerModelAvailable({
            id: createId(),
            model: {
              id: model.source.id,
              displayName: model.source.displayName,
              format: model.source.format,
              url: entryUrl,
            },
          })))
        }

        const motionCatalog: MotionDescriptor[] = []
        if (model?.source.format === 'live2d' && boundAddress) {
          for (const motion of model.live2dMotions) {
            const descriptor: Live2dMotionDescriptor = {
              id: motion.id,
              displayName: motion.displayName,
              format: 'live2d',
              url: createAssetUrlForPath(boundAddress, model, motion.file),
              group: motion.group,
              index: motion.index,
            }
            motionCatalog.push(descriptor)
          }
        }
        if (preparedMotions.length > 0 && boundAddress) {
          motionCatalog.push(...preparedMotions.map(motion => ({
            id: motion.source.id,
            displayName: motion.source.displayName,
            format: motion.source.format,
            url: createAssetUrl(boundAddress, motion),
            ...(motion.source.loop !== undefined ? { loop: motion.source.loop } : {}),
          })))
        }

        if (motionCatalog.length > 0) {
          outbound.push(serializeWireMessage(createServerMotionCatalog({
            id: createId(),
            motions: motionCatalog,
          })))
        }

        for (const payload of outbound) socket.send(payload)
        welcomedClients.add(socket)
      }
      catch {
        welcomedClients.delete(socket)
        sendErrorAndClose(
          socket,
          'internal_error',
          'Companion could not initialize the session',
          1011,
          message.id,
        )
      }
    })

    socket.once('close', () => {
      clearTimeout(helloTimer)
      welcomedClients.delete(socket)
    })
    socket.on('error', () => {
      // Close and server state events own diagnostics; never throw from a socket callback.
    })
  }

  function sendErrorAndClose(
    socket: WebSocket,
    code: 'invalid_message' | 'hello_timeout' | 'duplicate_hello' | 'internal_error',
    message: string,
    closeCode: number,
    replyTo?: string,
  ): void {
    if (socket.readyState !== WebSocket.OPEN) return
    try {
      socket.send(serializeWireMessage(createServerError({
        id: createId(),
        ...(replyTo === undefined ? {} : { replyTo }),
        code,
        message,
      })))
    }
    catch {
      // Closing is the security boundary even when the diagnostic cannot be sent.
    }
    socket.close(closeCode, code)
  }

  function onRuntimeError(cause: Error): void {
    phase = 'error'
    error = toErrorMessage(cause)
  }

  async function stop(): Promise<void> {
    if (stopPromise) return stopPromise
    if (!httpServer && !webSocketServer) {
      phase = 'stopped'
      address = undefined
      preparedModel = undefined
      return
    }

    phase = 'stopping'
    stopPromise = stopServers(httpServer, webSocketServer)
    try {
      await stopPromise
      phase = 'stopped'
      error = undefined
    }
    catch (cause) {
      phase = 'error'
      error = toErrorMessage(cause)
      throw cause
    }
    finally {
      httpServer = undefined
      webSocketServer = undefined
      address = undefined
      preparedModel = undefined
      welcomedClients.clear()
      assetTokenMap.clear()
      generatedTokenMap.clear()
      stopPromise = undefined
    }
  }

  function publishMotion(input: {
    id: string
    displayName: string
    motion: CanonicalMotion
    loop?: boolean
  }): MotionDescriptor {
    if (phase !== 'running' || address === undefined) {
      throw new Error('Companion must be running before publishing a generated motion')
    }
    const motionId = requireMotionId(input.id)
    const displayName = requireDisplayName(input.displayName, 'generated motion displayName', 96)
    validateCanonicalMotion(input.motion)
    const content = Buffer.from(JSON.stringify(input.motion), 'utf8')
    const loop = input.loop ?? false
    if (typeof loop !== 'boolean') throw new Error('generated motion loop must be boolean')

    const assetToken = createAssetToken()
    if (!ASSET_TOKEN_PATTERN.test(assetToken)) {
      throw new Error('Asset token must contain 16-128 URL-safe characters')
    }
    const entryFileName = `${motionId}.json`
    generatedTokenMap.set(assetToken, {
      kind: 'generated',
      assetToken,
      entryFileName,
      content,
      displayName,
      motionId,
      loop,
    })

    const descriptor: MotionDescriptor = {
      id: motionId,
      displayName,
      format: 'canonical',
      url: createGeneratedMotionUrl(address, {
        assetToken,
        entryFileName,
      }),
      ...(loop ? { loop } : {}),
    }

    const serialized = serializeWireMessage(createServerMotionPublished({
      id: createId(),
      motion: descriptor,
    }))
    for (const socket of welcomedClients) {
      if (socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(serialized)
        }
        catch {
          // A single lagging client must not drop the published motion.
        }
      }
    }
    return descriptor
  }

  function snapshot(): CompanionServerSnapshot {
    return {
      phase,
      connectedClients: welcomedClients.size,
      modelAvailable: preparedModel !== undefined,
      ...(address === undefined ? {} : { address }),
      ...(error === undefined ? {} : { error }),
    }
  }

  return { start, stop, snapshot, publishMotion }
}

async function prepareModel(source: CompanionModelSource, assetToken: string): Promise<PreparedModel> {
  if (!ASSET_TOKEN_PATTERN.test(assetToken)) {
    throw new Error('Asset token must contain 16-128 URL-safe characters')
  }
  const entryFilePath = await realpath(source.entryFilePath)
  const metadata = await stat(entryFilePath)
  const normalizedEntryPath = entryFilePath.toLowerCase()
  const validEntry = source.format === 'live2d'
    ? normalizedEntryPath.endsWith('.model3.json')
    : extname(entryFilePath).toLowerCase() === '.pmx'
  if (!metadata.isFile() || !validEntry) {
    const label = source.format === 'live2d' ? 'Live2D model3.json' : 'PMX'
    throw new Error(`Companion model entry must be a regular ${label} file`)
  }
  const live2dMotions = source.format === 'live2d'
    ? await readLive2dMotionCatalog(entryFilePath)
    : []
  return {
    source: { ...source, entryFilePath },
    rootPath: dirname(entryFilePath),
    entryFileName: entryFilePath.slice(dirname(entryFilePath).length + 1),
    assetToken,
    live2dMotions,
  }
}

async function prepareMotion(source: CompanionMotionSource, assetToken: string): Promise<PreparedMotion> {
  if (!ASSET_TOKEN_PATTERN.test(assetToken)) {
    throw new Error('Asset token must contain 16-128 URL-safe characters')
  }
  const entryFilePath = await realpath(source.entryFilePath)
  const metadata = await stat(entryFilePath)
  if (!metadata.isFile() || extname(entryFilePath).toLowerCase() !== '.vmd') {
    throw new Error('Companion motion entry must be a regular VMD file')
  }
  return {
    source: { ...source, entryFilePath },
    rootPath: dirname(entryFilePath),
    entryFileName: entryFilePath.slice(dirname(entryFilePath).length + 1),
    assetToken,
  }
}

async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  assets: Map<string, PreparedAsset>,
  generated: Map<string, PreparedGeneratedMotion>,
): Promise<void> {
  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD')
      respond(response, 405, 'Method Not Allowed')
      return
    }
    if (!isAllowedBrowserOrigin(request.headers.origin)) {
      respond(response, 403, 'Forbidden')
      return
    }

    const requestUrl = parseRequestUrl(request)
    if (!requestUrl || requestUrl.search.length > 0) {
      respond(response, 400, 'Bad Request')
      return
    }

    const match = /^\/assets\/([A-Za-z0-9_-]{16,128})\/(.+)$/u.exec(requestUrl.pathname)
    if (!match) {
      respond(response, 404, 'Not Found')
      return
    }

    const token = match[1]!
    const segments = decodeAssetSegments(match[2]!)
    if (!segments) {
      respond(response, 400, 'Bad Request')
      return
    }

    const generatedMotion = generated.get(token)
    if (generatedMotion !== undefined) {
      serveGeneratedMotion(response, request.method, generatedMotion, segments, request.headers.origin)
      return
    }

    const asset = assets.get(token)
    if (!asset) {
      respond(response, 404, 'Not Found')
      return
    }

    const extension = extname(segments.at(-1) ?? '').toLowerCase()
    if (!ALLOWED_ASSET_EXTENSIONS.has(extension)) {
      respond(response, 403, 'Forbidden')
      return
    }

    const candidate = resolve(asset.rootPath, ...segments)
    if (!isContainedPath(asset.rootPath, candidate)) {
      respond(response, 403, 'Forbidden')
      return
    }

    let targetPath: string
    let metadata
    try {
      targetPath = await realpath(candidate)
      if (!isContainedPath(asset.rootPath, targetPath)) {
        respond(response, 403, 'Forbidden')
        return
      }
      metadata = await stat(targetPath)
    }
    catch {
      respond(response, 404, 'Not Found')
      return
    }
    if (!metadata.isFile()) {
      respond(response, 404, 'Not Found')
      return
    }
    if (metadata.size > MAX_ASSET_BYTES) {
      respond(response, 413, 'Content Too Large')
      return
    }

    applyAssetHeaders(response, request.headers.origin, extension, metadata.size)
    response.statusCode = 200
    if (request.method === 'HEAD') {
      response.end()
      return
    }

    const stream = createReadStream(targetPath)
    stream.once('error', () => response.destroy())
    stream.pipe(response)
  }
  catch {
    if (!response.headersSent) respond(response, 500, 'Internal Server Error')
    else response.destroy()
  }
}

function serveGeneratedMotion(
  response: ServerResponse,
  method: string,
  motion: PreparedGeneratedMotion,
  segments: readonly string[],
  origin: string | undefined,
): void {
  if (segments.length !== 1 || segments[0] !== motion.entryFileName) {
    respond(response, 404, 'Not Found')
    return
  }
  if (motion.content.byteLength > MAX_ASSET_BYTES) {
    respond(response, 413, 'Content Too Large')
    return
  }
  applyAssetHeaders(response, origin, '.json', motion.content.byteLength)
  response.statusCode = 200
  if (method === 'HEAD') {
    response.end()
    return
  }
  response.end(motion.content)
}

function applyAssetHeaders(
  response: ServerResponse,
  origin: string | undefined,
  extension: string,
  size: number,
): void {
  if (origin !== undefined) response.setHeader('Access-Control-Allow-Origin', origin)
  response.setHeader('Cache-Control', 'private, max-age=300')
  response.setHeader('Content-Length', String(size))
  response.setHeader('Content-Type', contentTypeFor(extension))
  response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Vary', 'Origin')
}

function decodeAssetSegments(encodedPath: string): string[] | undefined {
  if (encodedPath.length < 1 || encodedPath.length > 4096) return undefined
  const encodedSegments = encodedPath.split('/')
  if (encodedSegments.length > 32) return undefined
  const segments: string[] = []
  for (const encoded of encodedSegments) {
    let segment: string
    try {
      segment = decodeURIComponent(encoded)
    }
    catch {
      return undefined
    }
    if (
      segment.length < 1
      || segment === '.'
      || segment === '..'
      || segment.includes('/')
      || segment.includes('\\')
      || segment.includes('\u0000')
    ) return undefined
    segments.push(segment)
  }
  return segments
}

function isContainedPath(rootPath: string, candidate: string): boolean {
  const pathFromRoot = relative(rootPath, candidate)
  return pathFromRoot.length === 0
    || (pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
}

function isAllowedBrowserOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === 'null' || origin.startsWith('file://')) return true
  let parsed: URL
  try {
    parsed = new URL(origin)
  }
  catch {
    return false
  }
  return parsed.protocol === 'http:'
    && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
    && parsed.username.length === 0
    && parsed.password.length === 0
}

function createAssetUrl(address: CompanionServerAddress, asset: PreparedAsset): string {
  const encodedEntry = asset.entryFileName.split(/[\\/]/u).map(encodeURIComponent).join('/')
  return `http://${address.host}:${address.port}/assets/${asset.assetToken}/${encodedEntry}`
}

function createGeneratedMotionUrl(
  address: CompanionServerAddress,
  motion: Pick<PreparedGeneratedMotion, 'assetToken' | 'entryFileName'>,
): string {
  return `http://${address.host}:${address.port}/assets/${motion.assetToken}/${encodeURIComponent(motion.entryFileName)}`
}

function createAssetUrlForPath(
  address: CompanionServerAddress,
  asset: PreparedAsset,
  relativePath: string,
): string {
  const encodedPath = relativePath
    .replaceAll('\\', '/')
    .split('/')
    .map(encodeURIComponent)
    .join('/')
  return `http://${address.host}:${address.port}/assets/${asset.assetToken}/${encodedPath}`
}

function parseRequestUrl(request: IncomingMessage): URL | undefined {
  if (!request.url) return undefined
  try {
    return new URL(request.url, `http://${LOOPBACK_HOST}`)
  }
  catch {
    return undefined
  }
}

function contentTypeFor(extension: string): string {
  const contentTypes: Record<string, string> = {
    '.bmp': 'image/bmp',
    '.dds': 'image/vnd-ms.dds',
    '.gif': 'image/gif',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.json': 'application/json',
    '.moc3': 'application/octet-stream',
    '.pmx': 'application/octet-stream',
    '.png': 'image/png',
    '.spa': 'image/bmp',
    '.sph': 'image/bmp',
    '.tga': 'image/x-tga',
    '.webp': 'image/webp',
  }
  return contentTypes[extension] ?? 'application/octet-stream'
}

function respond(response: ServerResponse, statusCode: number, body: string): void {
  response.statusCode = statusCode
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('Content-Type', 'text/plain; charset=utf-8')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.end(body)
}

function rejectUpgrade(socket: Duplex, statusCode: number, statusText: string): void {
  socket.end(
    `HTTP/1.1 ${statusCode} ${statusText}\r\n`
    + 'Connection: close\r\n'
    + 'Content-Length: 0\r\n'
    + '\r\n',
  )
}

function listen(server: HttpServer, port: number): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const onListening = (): void => {
      server.off('error', onStartupError)
      resolvePromise()
    }
    const onStartupError = (cause: Error): void => {
      server.off('listening', onListening)
      rejectPromise(cause)
    }
    server.once('listening', onListening)
    server.once('error', onStartupError)
    server.listen(port, LOOPBACK_HOST)
  })
}

async function stopServers(
  httpServer: HttpServer | undefined,
  webSocketServer: WebSocketServer | undefined,
): Promise<void> {
  if (webSocketServer) {
    for (const socket of webSocketServer.clients) socket.terminate()
  }
  await Promise.all([
    closeHttpServer(httpServer),
    closeWebSocketServer(webSocketServer),
  ])
}

async function cleanupFailedStart(
  httpServer: HttpServer | undefined,
  webSocketServer: WebSocketServer | undefined,
): Promise<void> {
  try {
    await stopServers(httpServer?.listening === true ? httpServer : undefined, webSocketServer)
  }
  catch {
    // Preserve the startup error.
  }
}

function closeHttpServer(server: HttpServer | undefined): Promise<void> {
  if (!server || !server.listening) return Promise.resolve()
  return new Promise((resolvePromise, rejectPromise) => {
    server.close(cause => cause ? rejectPromise(cause) : resolvePromise())
  })
}

function closeWebSocketServer(server: WebSocketServer | undefined): Promise<void> {
  if (!server) return Promise.resolve()
  return new Promise((resolvePromise, rejectPromise) => {
    server.close(cause => cause ? rejectPromise(cause) : resolvePromise())
  })
}

function toText(data: RawData): string {
  if (typeof data === 'string') return data
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return data.toString('utf8')
}

function toAddress(address: AddressInfo): CompanionServerAddress {
  if (address.address !== LOOPBACK_HOST) throw new Error(`Companion server escaped loopback: ${address.address}`)
  return { host: LOOPBACK_HOST, port: address.port }
}

function requirePort(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new Error('Companion port must be an integer from 0 through 65535')
  }
  return value
}

function requireHelloTimeout(value: number): number {
  if (!Number.isFinite(value) || value < 10 || value > 60_000) {
    throw new Error('helloTimeoutMs must be between 10 and 60000')
  }
  return value
}

function requireMotionId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/u.test(value)) {
    throw new Error('generated motion id must be a 1-64 character identifier')
  }
  return value
}

function requireDisplayName(value: unknown, name: string, maximumLength: number): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maximumLength
    || value.trim() !== value
    || /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    throw new Error(`${name} must be a trimmed printable string up to ${maximumLength} characters`)
  }
  return value
}

function toErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
