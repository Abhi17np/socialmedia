import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './theme.css'
import App from './App.jsx'
import PlatformApp from './platform/PlatformApp.jsx'

// /platform is a structurally separate app, not a view inside App.jsx —
// its own login, its own token (localStorage 'platform_token', never
// 'token'), its own backend gate (requirePlatformAdmin, not requireAuth).
// A plain path check is enough here; this repo has no router, and
// Platform Admin is one page, not a set of routes that would need one.
const isPlatform = window.location.pathname.startsWith('/platform');

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {isPlatform ? <PlatformApp /> : <App />}
  </StrictMode>,
)
