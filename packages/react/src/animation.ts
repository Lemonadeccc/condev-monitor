'use client'

export * from '@condev-monitor/monitor-sdk-browser/animation'

export { CondevAnimationProfiler } from './animation-profiler'
export { createCondevReactComponentScope } from './framework-component-scope'
export type { CondevReactComponentScope, CondevReactComponentScopeOptions } from './framework-component-scope'
export type { CondevAnimationProfilerProps } from './animation-profiler'
export { CondevErrorBoundary, withErrorBoundary } from './error-boundary'
export type { CondevErrorBoundaryProps } from './error-boundary'
export { MonitorUser, useMonitorUser } from './hooks'
