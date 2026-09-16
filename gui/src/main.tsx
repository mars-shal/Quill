import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
// Bundled Google typefaces, offline-safe (CSP allows 'self' only, no CDN).
// 400 = body, 400-italic = emphasis, 700 = headings / strong.
import '@fontsource/inter/400.css'
import '@fontsource/inter/400-italic.css'
import '@fontsource/inter/700.css'
import '@fontsource/lora/400.css'
import '@fontsource/lora/400-italic.css'
import '@fontsource/lora/700.css'
import '@fontsource/literata/400.css'
import '@fontsource/literata/400-italic.css'
import '@fontsource/literata/700.css'
import '@fontsource/newsreader/400.css'
import '@fontsource/newsreader/400-italic.css'
import '@fontsource/newsreader/700.css'
import '@fontsource/source-serif-4/400.css'
import '@fontsource/source-serif-4/400-italic.css'
import '@fontsource/source-serif-4/700.css'
import '@fontsource/work-sans/400.css'
import '@fontsource/work-sans/400-italic.css'
import '@fontsource/work-sans/700.css'
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/400-italic.css'
import '@fontsource/ibm-plex-sans/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/400-italic.css'
import '@fontsource/jetbrains-mono/700.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/400-italic.css'
import '@fontsource/ibm-plex-mono/700.css'
import './styles.css'

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)