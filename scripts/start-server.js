import { createServer } from 'vite'
import path from 'path'
import fs from 'fs'
import { spawn } from 'child_process'

const args = process.argv
const dirIdx = args.indexOf('--storage-dir')
let storageDir = ''
if (dirIdx !== -1 && args[dirIdx + 1]) {
  storageDir = args[dirIdx + 1]
} else {
  storageDir = process.env.VITE_STORAGE_DIR || 'storage'
}

// Make sure storage dir is resolved and exists
const absoluteStorageDir = path.resolve(process.cwd(), storageDir)
if (!fs.existsSync(absoluteStorageDir)) {
  fs.mkdirSync(absoluteStorageDir, { recursive: true })
}

process.env.VITE_STORAGE_DIR = absoluteStorageDir
console.log(`[Storage Server] Materializing local storage in: ${absoluteStorageDir}`)

// Check if mode is provided
const modeIdx = args.indexOf('--mode')
const mode = (modeIdx !== -1 && args[modeIdx + 1]) ? args[modeIdx + 1] : undefined

// Check if host is provided to expose server (e.g. --host or --host 0.0.0.0)
const hostIdx = args.indexOf('--host')
let host = undefined
if (hostIdx !== -1) {
  if (args[hostIdx + 1] && !args[hostIdx + 1].startsWith('-')) {
    host = args[hostIdx + 1]
  } else {
    host = true
  }
}

// 1. Spawn Python API Backend Server
// Prefer conda Python (has scraping dependencies installed), fallback to system python3
const condaPython = path.join(process.env.HOME || '', 'miniconda3', 'bin', 'python3')
const pythonBin = fs.existsSync(condaPython) ? condaPython : 'python3'
console.log(`[Storage Server] Starting Python API server on port 3000 using ${pythonBin}...`)
const apiServerProcess = spawn(pythonBin, [
  path.join(process.cwd(), 'scripts', 'api_server.py'),
  '--storage-dir', absoluteStorageDir,
  '--host', '127.0.0.1',
  '--port', '3000'
])

// Forward API server output
apiServerProcess.stdout.on('data', (data) => {
  process.stdout.write(`[API Server] ${data}`)
})

apiServerProcess.stderr.on('data', (data) => {
  process.stderr.write(`[API Server ERR] ${data}`)
})

// Cleanup handlers
const cleanup = () => {
  if (apiServerProcess && !apiServerProcess.killed) {
    console.log('[Storage Server] Terminating API server...')
    apiServerProcess.kill('SIGTERM')
  }
}

process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit() })
process.on('SIGTERM', () => { cleanup(); process.exit() })
process.on('uncaughtException', (err) => {
  console.error('[Storage Server] Uncaught Exception:', err)
  cleanup()
  process.exit(1)
})

// 2. Start Vite dev server programmatically
try {
  const server = await createServer({
    mode,
    server: {
      host
    }
  })
  await server.listen()
  server.printUrls()
} catch (err) {
  console.error('Failed to start Vite dev server:', err)
  cleanup()
  process.exit(1)
}

