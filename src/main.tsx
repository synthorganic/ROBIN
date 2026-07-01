/**
 * main.tsx — ROBIN application entry point.
 *
 * Mounts the React root and wraps the app in ErrorBoundary → StrictMode with providers.
 * Providers: Gateway, Settings, Session, Chat
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { GatewayProvider } from '@/contexts/GatewayContext'
import { SessionProvider } from '@/contexts/SessionContext'
import { ChatProvider } from '@/contexts/ChatContext'
import { SettingsProvider } from '@/contexts/SettingsContext'
import App from '@/App'

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <StrictMode>
      <SettingsProvider>
        <GatewayProvider>
          <SessionProvider>
            <ChatProvider>
              <App />
            </ChatProvider>
          </SessionProvider>
        </GatewayProvider>
      </SettingsProvider>
    </StrictMode>
  </ErrorBoundary>,
)
