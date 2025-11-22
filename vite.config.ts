import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  const env = loadEnv(mode, process.cwd(), '');
  
  return {
    plugins: [react()],
    define: {
      // Environment variable injection for client side
      // Priority: Process Environment (Vercel) > .env file
      'process.env.API_KEY': JSON.stringify(process.env.API_KEY || env.API_KEY),
    }
  }
})