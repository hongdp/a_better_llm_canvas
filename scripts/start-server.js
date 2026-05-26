import { createServer } from 'vite'
import path from 'path'
import fs from 'fs'

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

// Start Vite dev server programmatically
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
  process.exit(1)
}
