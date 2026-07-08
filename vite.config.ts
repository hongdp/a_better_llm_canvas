import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'

// Resolve cert paths relative to this config file, not the cwd, so it works
// regardless of how the dev server is launched (systemd, npm, etc.).
const certPath = (f: string) => fileURLToPath(new URL(`./certs/${f}`, import.meta.url))

// Self-signed dev cert generated with proper IP SAN entries (see certs/san.cnf).
// basic-ssl only covered localhost/127.0.0.1, so accessing via a LAN/Tailscale
// IP gave a domain mismatch: Chrome lets you click through, but Firefox then
// rejects same-origin fetch()/XHR with "NetworkError when attempting to fetch
// resource". A cert whose SAN lists the actual IPs (as IP Address entries, not
// DNS) fixes it for both browsers. Regenerate with:
//   openssl req -x509 -newkey rsa:2048 -nodes \
//     -keyout certs/dev-key.pem -out certs/dev-cert.pem -days 825 -config certs/san.cnf

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    https: {
      key: readFileSync(certPath('dev-key.pem')),
      cert: readFileSync(certPath('dev-cert.pem')),
    },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true
      }
    }
  }
})
