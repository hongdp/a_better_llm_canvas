/* eslint-disable @typescript-eslint/no-explicit-any */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'

// Vite plugin to serve/store local storage state in a 지정 directory
function storagePlugin() {
  return {
    name: 'web-canvas-storage',
    configureServer(server: any) {
      server.middlewares.use(async (req: any, res: any, next: any) => {
        if (req.url?.startsWith('/api/storage')) {
          const storageDir = process.env.VITE_STORAGE_DIR || path.resolve(process.cwd(), 'storage')
          const dbPath = path.join(storageDir, 'state.json')

          if (req.method === 'GET') {
            res.setHeader('Content-Type', 'application/json')
            if (fs.existsSync(dbPath)) {
              const data = fs.readFileSync(dbPath, 'utf-8')
              res.end(data)
            } else {
              res.end(JSON.stringify({}))
            }
          } else if (req.method === 'POST') {
            let body = ''
            req.on('data', (chunk: any) => { body += chunk })
            req.on('end', () => {
              try {
                if (!fs.existsSync(storageDir)) {
                  fs.mkdirSync(storageDir, { recursive: true })
                }
                fs.writeFileSync(dbPath, body, 'utf-8')
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ success: true }))
              } catch (err: any) {
                res.statusCode = 500
                res.end(JSON.stringify({ error: err.message }))
              }
            })
          }
        } else {
          next()
        }
      })
    }
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), storagePlugin()],
})

