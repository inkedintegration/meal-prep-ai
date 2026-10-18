import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Minimal for now: PWA service worker lands with the deploy milestone.
export default defineConfig({
  plugins: [react()],
})
