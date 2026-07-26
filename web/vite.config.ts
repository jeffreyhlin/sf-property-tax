import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // preview harness assigns a port via PORT; vite doesn't read it natively
  server: { port: Number(process.env.PORT) || undefined },
})
