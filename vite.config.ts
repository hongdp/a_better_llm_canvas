/* eslint-disable @typescript-eslint/no-explicit-any */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

// Vite plugin to serve/store user specific local storage state in a designated directory with authentication
function storagePlugin() {
  return {
    name: 'web-canvas-storage',
    configureServer(server: any) {
      server.middlewares.use(async (req: any, res: any, next: any) => {
        const url = req.url || ''
        
        // Helper to parse cookies
        const parseCookies = (cookieHeader?: string) => {
          const cookies: Record<string, string> = {}
          if (!cookieHeader) return cookies
          cookieHeader.split(';').forEach((cookie) => {
            const parts = cookie.split('=')
            if (parts.length >= 2) {
              cookies[parts[0].trim()] = decodeURIComponent(parts.slice(1).join('=').trim())
            }
          })
          return cookies
        }

        // Helper to set cookies
        const setCookies = (res: any, cookiesList: { name: string, value: string, options?: any }[]) => {
          const headers = cookiesList.map(c => {
            let cookieStr = `${c.name}=${encodeURIComponent(c.value)}`
            const opt = c.options || {}
            if (opt.path) cookieStr += `; Path=${opt.path}`
            if (opt.httpOnly) cookieStr += `; HttpOnly`
            if (opt.maxAge !== undefined) cookieStr += `; Max-Age=${opt.maxAge}`
            if (opt.sameSite) cookieStr += `; SameSite=${opt.sameSite}`
            return cookieStr
          })
          res.setHeader('Set-Cookie', headers)
        }

        // Helper to read request body
        const readBody = (): Promise<string> => {
          return new Promise((resolve) => {
            let body = ''
            req.on('data', (chunk: any) => { body += chunk })
            req.on('end', () => resolve(body))
          })
        }

        const storageDir = process.env.VITE_STORAGE_DIR || path.resolve(process.cwd(), 'storage')
        if (!fs.existsSync(storageDir)) {
          fs.mkdirSync(storageDir, { recursive: true })
        }

        const usersFile = path.join(storageDir, 'users.json')
        const sessionsFile = path.join(storageDir, 'sessions.json')

        // Load files safely
        const loadJSONFile = (filePath: string): any => {
          if (fs.existsSync(filePath)) {
            try {
              return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
            } catch {
              return {}
            }
          }
          return {}
        }

        const saveJSONFile = (filePath: string, data: any) => {
          fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
        }

        const cookies = parseCookies(req.headers.cookie)

        // CSRF Token Check for state-changing requests (POST)
        if (req.method === 'POST') {
          const csrfHeader = req.headers['x-csrf-token']
          const csrfCookie = cookies['csrf_token']
          if (!csrfCookie || csrfHeader !== csrfCookie) {
            res.statusCode = 403
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'CSRF token mismatch or missing.' }))
            return
          }
        }

        // 1. Session GET endpoint
        if (url.startsWith('/api/auth/session') && req.method === 'GET') {
          res.setHeader('Content-Type', 'application/json')
          
          // Generate CSRF token if missing
          let csrfToken = cookies['csrf_token']
          const newCookies = []
          if (!csrfToken) {
            csrfToken = crypto.randomBytes(16).toString('hex')
            newCookies.push({
              name: 'csrf_token',
              value: csrfToken,
              options: { httpOnly: false, path: '/', sameSite: 'Lax', maxAge: 60 * 60 * 24 * 365 }
            })
          }

          const sessionId = cookies['web_canvas_session']
          const sessions = loadJSONFile(sessionsFile)
          const session = sessionId ? sessions[sessionId] : null

          if (session && session.username && new Date(session.expiresAt) > new Date()) {
            if (newCookies.length > 0) setCookies(res, newCookies)
            res.end(JSON.stringify({ loggedIn: true, username: session.username, csrfToken }))
          } else {
            if (newCookies.length > 0) setCookies(res, newCookies)
            res.end(JSON.stringify({ loggedIn: false, csrfToken }))
          }
          return
        }

        // 2. Register endpoint
        if (url.startsWith('/api/auth/register') && req.method === 'POST') {
          res.setHeader('Content-Type', 'application/json')
          const bodyText = await readBody()
          try {
            const { username, password } = JSON.parse(bodyText)
            
            // Validation
            if (!username || !/^[a-zA-Z0-9_-]{3,30}$/.test(username)) {
              res.statusCode = 400
              res.end(JSON.stringify({ error: 'Username must be alphanumeric, between 3 and 30 characters.' }))
              return
            }
            if (!password || password.length < 8) {
              res.statusCode = 400
              res.end(JSON.stringify({ error: 'Password must be at least 8 characters long.' }))
              return
            }

            const users = loadJSONFile(usersFile)
            if (users[username]) {
              res.statusCode = 400
              res.end(JSON.stringify({ error: 'Username is already taken.' }))
              return
            }

            const salt = crypto.randomBytes(16).toString('hex')
            const hash = crypto.scryptSync(password, salt, 64).toString('hex')
            
            users[username] = { username, salt, hash }
            saveJSONFile(usersFile, users)

            res.end(JSON.stringify({ success: true }))
          } catch (e: any) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: 'Invalid JSON payload.' }))
          }
          return
        }

        // 3. Login endpoint
        if (url.startsWith('/api/auth/login') && req.method === 'POST') {
          res.setHeader('Content-Type', 'application/json')
          const bodyText = await readBody()
          try {
            const { username, password } = JSON.parse(bodyText)
            const users = loadJSONFile(usersFile)
            const user = users[username]

            if (!user) {
              res.statusCode = 401
              res.end(JSON.stringify({ error: 'Invalid username or password.' }))
              return
            }

            const checkHash = crypto.scryptSync(password, user.salt, 64).toString('hex')
            if (checkHash !== user.hash) {
              res.statusCode = 401
              res.end(JSON.stringify({ error: 'Invalid username or password.' }))
              return
            }

            // Create session
            const sessionId = crypto.randomBytes(32).toString('hex')
            const sessions = loadJSONFile(sessionsFile)
            const expiresAt = new Date()
            expiresAt.setDate(expiresAt.getDate() + 7) // 7 days

            // Invalidate all other active sessions globally to ensure only one user is logged in
            for (const key of Object.keys(sessions)) {
              delete sessions[key]
            }

            sessions[sessionId] = { username, expiresAt: expiresAt.toISOString() }
            saveJSONFile(sessionsFile, sessions)

            // Set session cookie
            const responseCookies = [
              {
                name: 'web_canvas_session',
                value: sessionId,
                options: { httpOnly: true, path: '/', sameSite: 'Lax', maxAge: 60 * 60 * 24 * 7 }
              }
            ]
            
            // Set fresh csrf token too
            let csrfToken = cookies['csrf_token']
            if (!csrfToken) {
              csrfToken = crypto.randomBytes(16).toString('hex')
              responseCookies.push({
                name: 'csrf_token',
                value: csrfToken,
                options: { httpOnly: false, path: '/', sameSite: 'Lax', maxAge: 60 * 60 * 24 * 365 }
              })
            }

            setCookies(res, responseCookies)
            res.end(JSON.stringify({ success: true, username, csrfToken }))
          } catch (e: any) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: 'Invalid request.' }))
          }
          return
        }

        // 4. Logout endpoint
        if (url.startsWith('/api/auth/logout') && req.method === 'POST') {
          res.setHeader('Content-Type', 'application/json')
          const sessionId = cookies['web_canvas_session']
          if (sessionId) {
            const sessions = loadJSONFile(sessionsFile)
            delete sessions[sessionId]
            saveJSONFile(sessionsFile, sessions)
          }

          setCookies(res, [
            {
              name: 'web_canvas_session',
              value: '',
              options: { httpOnly: true, path: '/', sameSite: 'Lax', maxAge: -1 }
            }
          ])
          res.end(JSON.stringify({ success: true }))
          return
        }

        // 5. User-Isolated Storage Endpoint
        if (url.startsWith('/api/storage')) {
          const sessionId = cookies['web_canvas_session']
          const sessions = loadJSONFile(sessionsFile)
          const session = sessionId ? sessions[sessionId] : null

          if (!session || !session.username || new Date(session.expiresAt) <= new Date()) {
            res.statusCode = 401
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Authentication required.' }))
            return
          }

          const username = session.username
          // Path traversal mitigation
          const safeUsername = path.basename(username).replace(/[^a-zA-Z0-9_-]/g, '')
          
          // Parse bookId
          const parsedUrl = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`)
          const bookId = parsedUrl.searchParams.get('bookId') || 'default'

          let dbPath = path.join(storageDir, `state_${safeUsername}.json`)
          if (bookId && bookId !== 'default') {
            const safeBookId = path.basename(bookId).replace(/[^a-zA-Z0-9_-]/g, '')
            dbPath = path.join(storageDir, `state_${safeUsername}_${safeBookId}.json`)
          }

          // Directory boundary verify
          const resolvedPath = path.resolve(dbPath)
          const resolvedStorageDir = path.resolve(storageDir)
          if (!resolvedPath.startsWith(resolvedStorageDir + path.sep)) {
            res.statusCode = 403
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Access denied: Directory traversal detected.' }))
            return
          }

          if (req.method === 'GET') {
            res.setHeader('Content-Type', 'application/json')
            if (fs.existsSync(dbPath)) {
              const data = fs.readFileSync(dbPath, 'utf-8')
              res.end(data)
            } else {
              res.end(JSON.stringify({}))
            }
          } else if (req.method === 'POST') {
            const body = await readBody()
            try {
              fs.writeFileSync(dbPath, body, 'utf-8')
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ success: true }))
            } catch (err: any) {
              res.statusCode = 500
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: err.message }))
            }
          }
          return
        }

        // 6. List books endpoint
        if (url.startsWith('/api/books') && !url.startsWith('/api/books/delete') && req.method === 'GET') {
          const sessionId = cookies['web_canvas_session']
          const sessions = loadJSONFile(sessionsFile)
          const session = sessionId ? sessions[sessionId] : null

          if (!session || !session.username || new Date(session.expiresAt) <= new Date()) {
            res.statusCode = 401
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Authentication required.' }))
            return
          }

          const username = session.username
          const safeUsername = path.basename(username).replace(/[^a-zA-Z0-9_-]/g, '')
          
          const books: { id: string; title: string; updatedAt: string }[] = []

          try {
            const files = fs.readdirSync(storageDir)
            
            // A. Check legacy/default book
            const defaultPath = path.join(storageDir, `state_${safeUsername}.json`)
            if (fs.existsSync(defaultPath)) {
              try {
                const content = JSON.parse(fs.readFileSync(defaultPath, 'utf-8'))
                const stats = fs.statSync(defaultPath)
                books.push({
                  id: 'default',
                  title: content.bookTitle || 'Untitled Book',
                  updatedAt: content.updatedAt || stats.mtime.toISOString()
                })
              } catch {
                const stats = fs.statSync(defaultPath)
                books.push({
                  id: 'default',
                  title: 'Untitled Book',
                  updatedAt: stats.mtime.toISOString()
                })
              }
            }

            // B. Check other books
            const prefix = `state_${safeUsername}_`
            files.forEach((file) => {
              if (file.startsWith(prefix) && file.endsWith('.json')) {
                const bookId = file.substring(prefix.length, file.length - 5)
                const filePath = path.join(storageDir, file)
                try {
                  const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
                  const stats = fs.statSync(filePath)
                  books.push({
                    id: bookId,
                    title: content.bookTitle || 'Untitled Book',
                    updatedAt: content.updatedAt || stats.mtime.toISOString()
                  })
                } catch {
                  const stats = fs.statSync(filePath)
                  books.push({
                    id: bookId,
                    title: 'Untitled Book',
                    updatedAt: stats.mtime.toISOString()
                  })
                }
              }
            })

            // Sort by updatedAt desc
            books.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
          } catch (err: any) {
            console.error('Failed to read books from storage directory', err)
          }

          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(books))
          return
        }

        // 7. Delete book endpoint
        if (url.startsWith('/api/books/delete') && req.method === 'POST') {
          const sessionId = cookies['web_canvas_session']
          const sessions = loadJSONFile(sessionsFile)
          const session = sessionId ? sessions[sessionId] : null

          if (!session || !session.username || new Date(session.expiresAt) <= new Date()) {
            res.statusCode = 401
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Authentication required.' }))
            return
          }

          const bodyText = await readBody()
          try {
            const { bookId } = JSON.parse(bodyText)
            if (!bookId) {
              res.statusCode = 400
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: 'Missing bookId.' }))
              return
            }

            const username = session.username
            const safeUsername = path.basename(username).replace(/[^a-zA-Z0-9_-]/g, '')
            
            let filePath = path.join(storageDir, `state_${safeUsername}.json`)
            if (bookId !== 'default') {
              const safeBookId = path.basename(bookId).replace(/[^a-zA-Z0-9_-]/g, '')
              filePath = path.join(storageDir, `state_${safeUsername}_${safeBookId}.json`)
            }

            // Verify directory boundary
            const resolvedPath = path.resolve(filePath)
            const resolvedStorageDir = path.resolve(storageDir)
            if (!resolvedPath.startsWith(resolvedStorageDir + path.sep)) {
              res.statusCode = 403
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: 'Access denied: Directory traversal detected.' }))
              return
            }

            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath)
            }
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ success: true }))
          } catch (e: any) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Invalid payload.' }))
          }
          return
        }

        // Fallthrough
        next()
      })
    }
  }
}

export default defineConfig({
  plugins: [react(), storagePlugin()],
})

