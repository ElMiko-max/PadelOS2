import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
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
