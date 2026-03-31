import 'normalize.css'
import { init as initCondev } from '@condev-monitor/monitor-sdk-browser'
import { createRoot } from 'react-dom/client'
import './antd.scss'
import App from './App.tsx'
import './index.css'

const condevDsn = import.meta.env.VITE_CONDEV_DSN?.trim()
const apiBase = import.meta.env.VITE_API_BASE?.trim()

if (condevDsn) {
  const traceHeaderOrigins: string[] = []
  if (apiBase) {
    try {
      traceHeaderOrigins.push(new URL(apiBase, window.location.origin).origin)
    } catch {
      // Ignore invalid local env values and keep browser monitoring enabled.
    }
  }

  initCondev({
    dsn: condevDsn,
    replay: {
      beforeErrorMs: 8000,
      afterErrorMs: 4000,
      maxEvents: 1200,
      record: {
        inlineImages: false,
        collectFonts: false,
        recordCanvas: false,
        mousemoveWait: 120,
      },
    },
    aiStreaming: {
      urlPatterns: ['/chat_on_docs'],
      traceHeaderOrigins,
    },
  })
}

createRoot(document.getElementById('root')!).render(<App />)
