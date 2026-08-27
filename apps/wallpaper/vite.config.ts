import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'
import type { Plugin } from 'vite'

const scratchRoot = fileURLToPath(new URL('../../scratch/', import.meta.url))
const browserPathShim = fileURLToPath(new URL('./src/live2d/path-browser.ts', import.meta.url))
const browserNodeBuiltinsShim = fileURLToPath(new URL('./src/browser-node-builtins.ts', import.meta.url))
const sceneArchiveRoot = fileURLToPath(new URL('../../scratch/japanese_room/public-scenes-archive/', import.meta.url))
const ardyAssetsRoot = fileURLToPath(new URL('../../scratch/ardy3d/', import.meta.url))
const ardyMotionFixture = fileURLToPath(new URL('../../.walk-motion.json', import.meta.url))

const SCENE_ROUTE_PREFIX = '/assets/scenes/'

const MIME_TYPES_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

/**
 * Serves the private Japanese-room backdrop from the scratch archive during
 * `vite dev` only. The file must stay untracked and must never enter the
 * wallpaper build, so it cannot live in `public/` — the verify audit blocks
 * `assets/scenes` in dist and git tracks nothing under scratch.
 */
function privateSceneArchivePlugin(): Plugin {
  return {
    name: 'rayure-private-scene-archive',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
        if (!pathname.startsWith(SCENE_ROUTE_PREFIX)) {
          next()
          return
        }
        const fileName = decodeURIComponent(pathname.slice(SCENE_ROUTE_PREFIX.length))
        if (fileName.length === 0 || fileName.includes('/') || fileName.includes('\\') || fileName.includes('\0') || fileName.includes('..')) {
          res.statusCode = 400
          res.end()
          return
        }
        const extension = fileName.slice(fileName.lastIndexOf('.')).toLowerCase()
        const mimeType = MIME_TYPES_BY_EXTENSION[extension]
        if (mimeType === undefined) {
          res.statusCode = 404
          res.end()
          return
        }
        let bytes: Buffer
        try {
          bytes = readFileSync(join(sceneArchiveRoot, fileName))
        }
        catch {
          res.statusCode = 404
          res.end()
          return
        }
        res.statusCode = 200
        res.setHeader('Content-Type', mimeType)
        res.setHeader('Cache-Control', 'no-store')
        res.end(bytes)
      })
    },
  }
}

/**
 * Dev-only routes for the ARDY 3D debug surface.  The official CoreSkin
 * mannequin fixture and any opt-in PMX (`?3dModelUrl=`) live outside the app
 * root (git-ignored), so they are served at fixed machine-independent routes
 * instead of the wallpaper knowing an absolute `/@fs/` path:
 *
 *   /@rayure-assets/<file>   scratch/ardy3d/ (core-skin-data.json, *.pmx)
 *   /@rayure-assets/walk-motion.json   root fixture (dev-only, allowlisted)
 *
 * Dev-only; the production bundle never references these routes.
 */
function rayureDebugAssetsPlugin(): Plugin {
  return {
    name: 'rayure-ardy-debug-assets',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
        if (pathname.startsWith('/@rayure-assets/')) {
          const fileName = decodeURIComponent(pathname.slice('/@rayure-assets/'.length))
          if (
            fileName.length === 0
            || fileName.includes('/')
            || fileName.includes('\\')
            || fileName.includes('\0')
            || fileName.includes('..')
          ) {
            res.statusCode = 400
            res.end()
            return
          }
          const mimeType = fileName.endsWith('.pmx')
            ? 'application/octet-stream'
            : 'application/json; charset=utf-8'
          const filePath = fileName === 'walk-motion.json'
            ? ardyMotionFixture
            : join(ardyAssetsRoot, fileName)
          serveStatic(res, filePath, mimeType)
          return
        }
        next()
      })
    },
  }
}

function serveStatic(res: import('node:http').ServerResponse, path: string, contentType: string): void {
  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  }
  catch {
    res.statusCode = 404
    res.end()
    return
  }
  res.statusCode = 200
  res.setHeader('Content-Type', contentType)
  res.setHeader('Cache-Control', 'no-store')
  res.end(bytes)
}

export default defineConfig({
  base: './',
  plugins: [privateSceneArchivePlugin(), rayureDebugAssetsPlugin()],
  resolve: {
    alias: {
      path: browserPathShim,
      // three-mmd-loader guards these dynamic imports behind a Node-runtime
      // check.  Resolve them explicitly so Vite does not inject browser
      // externals into the Wallpaper Engine bundle.
      'node:fs/promises': browserNodeBuiltinsShim,
      'node:url': browserNodeBuiltinsShim,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'chrome100',
    rolldownOptions: {
      output: {
        // Three.js is needed by the lightweight scene shell as well as the
        // optional PMX host.  Keep it cacheable and cap its chunks below the
        // default warning threshold instead of hiding a monolithic entry
        // bundle behind a larger warning limit.
        codeSplitting: {
          groups: [{
            name: 'three-runtime',
            test: /node_modules[\\/]three[\\/]/u,
            priority: 10,
            maxSize: 420 * 1024,
          }],
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
    fs: {
      // app root so dev-only probe pages (e.g. scratch/ardy3d/pmx-bones.html
      // importing from the app's node_modules) are servable in the dev server.
      allow: [scratchRoot, fileURLToPath(new URL('.', import.meta.url))],
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4174,
    strictPort: true,
  },
})
