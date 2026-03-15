// Re-export all browser SDK APIs
export * from '@condev-monitor/monitor-sdk-browser'

// React-specific exports
export { CondevErrorBoundary, withErrorBoundary } from './error-boundary'
export type { CondevErrorBoundaryProps } from './error-boundary'

export { useMonitorUser, MonitorUser } from './hooks'
