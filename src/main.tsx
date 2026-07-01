/**
 * main.tsx — ROBIN application entry point.
 *
 * Mounts the ROBIN OpsApp directly as the application shell.
 * No authentication - this is a local-only app.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import OpsApp from '@/features/ops/OpsApp'

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <StrictMode>
      <OpsApp onLogout={async () => {}} />
    </StrictMode>
  </ErrorBoundary>,
)
