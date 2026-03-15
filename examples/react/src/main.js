import { jsx as _jsx, jsxs as _jsxs } from 'react/jsx-runtime'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { init, CondevErrorBoundary, useMonitorUser } from '@condev-monitor/react'
// 1. Initialize (1 line)
init({ dsn: import.meta.env.VITE_CONDEV_DSN })
function BuggyButton() {
    const handleClick = () => {
        throw new Error('Test render error from BuggyButton')
    }
    return _jsx('button', { onClick: handleClick, children: 'Trigger Error' })
}
function App() {
    // 2. Sync user
    useMonitorUser({ id: 'demo-user', email: 'demo@example.com' })
    return _jsxs('div', {
        style: { padding: 24 },
        children: [
            _jsx('h1', { children: 'React + Condev Monitor Example' }),
            _jsx(CondevErrorBoundary, {
                fallback: ({ error, resetError }) =>
                    _jsxs('div', {
                        children: [
                            _jsxs('p', { children: ['Caught: ', error.message] }),
                            _jsx('button', { onClick: resetError, children: 'Reset' }),
                        ],
                    }),
                children: _jsx(BuggyButton, {}),
            }),
        ],
    })
}
createRoot(document.getElementById('root')).render(_jsx(StrictMode, { children: _jsx(App, {}) }))
