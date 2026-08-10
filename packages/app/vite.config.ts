import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/** Which build a device is actually running — shown in the UI so nobody ever has to
    guess whether a phone picked up a deploy. */
function buildStamp(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
  } catch {
    return 'dev'
  }
}

/**
 * Writes the build stamp beside the bundle so the DAEMON can read it and tell a phone which
 * build it should be running. Without this the two sides cannot compare notes, and a phone
 * serving an old bundle from the relay looks like a product with missing features.
 */
function stampPlugin() {
  return {
    name: 'longleash-build-stamp',
    closeBundle() {
      mkdirSync('dist', { recursive: true })
      writeFileSync('dist/build.json', JSON.stringify({ build: buildStamp() }) + '\n')
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), stampPlugin()],
  define: { __BUILD__: JSON.stringify(buildStamp()) },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: { app: 'index.html', welcome: 'welcome.html' },
    },
  },
})
