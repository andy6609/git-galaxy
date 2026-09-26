import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // 개발 중에는 /api를 파이썬 서버(server/app.py, 8787)로 넘긴다
  server: { port: 5173, proxy: { '/api': 'http://localhost:8787' } },
})
