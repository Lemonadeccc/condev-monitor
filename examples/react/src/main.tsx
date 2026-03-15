import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { init, CondevErrorBoundary, useMonitorUser } from '@condev-monitor/react'

// 1. Initialize (1 line)
init({ dsn: import.meta.env.VITE_CONDEV_DSN })

function BuggyButton() {
    const handleClick = () => {
        throw new Error('Test render error from BuggyButton')
    }
    return <button onClick={handleClick}>Trigger Error</button>
}

function App() {
    // 2. Sync user
    useMonitorUser({ id: 'demo-user', email: 'demo@example.com' })

    return (
        <div style={{ padding: 24 }}>
            <h1>React + Condev Monitor Example</h1>
            <CondevErrorBoundary
                fallback={({ error, resetError }) => (
                    <div>
                        <p>Caught: {error.message}</p>
                        <button onClick={resetError}>Reset</button>
                    </div>
                )}
            >
                <BuggyButton />
            </CondevErrorBoundary>
        </div>
    )
}

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <App />
    </StrictMode>
)
