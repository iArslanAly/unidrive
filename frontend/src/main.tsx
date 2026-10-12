import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './style.css'
import { hydrateThumbCache } from './lib/thumbQueue'

// Warm the in-memory thumbnail mirror from IndexedDB so the first render of any
// file card can read a persisted poster synchronously (0ms, no network). Runs
// once at startup; concurrent components await the same in-flight promise.
void hydrateThumbCache()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
