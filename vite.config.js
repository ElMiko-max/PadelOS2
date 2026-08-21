import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Writes dist/version.json with whatever APP_VERSION is actually baked into this build,
// read straight from src/App.jsx so there's a single source of truth — no separate value to
// remember to keep in sync. The "new version available" banner (App.jsx) polls this file to
// detect when a newer build has been deployed while a tab is still open on an older one.
function versionFilePlugin() {
  return {
    name: 'version-file',
    writeBundle() {
      const src = fs.readFileSync(path.resolve(__dirname, 'src/App.jsx'), 'utf8')
      const m = src.match(/const APP_VERSION = "([^"]+)"/)
      fs.writeFileSync(path.resolve(__dirname, 'dist/version.json'), JSON.stringify({ version: m ? m[1] : 'unknown' }))
    }
  }
}

export default defineConfig({
  plugins: [react(), versionFilePlugin()],
  resolve: {
    extensions: ['.jsx', '.js', '.tsx', '.ts']
  },
  build: {
    rollupOptions: {
      input: {
        main: './index.html'
      }
    }
  }
})
