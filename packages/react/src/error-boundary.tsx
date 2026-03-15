'use client'

import { getTransport } from '@condev-monitor/monitor-sdk-core'
import { Component, type ComponentType, type ErrorInfo, type FC, type ReactNode } from 'react'

export interface CondevErrorBoundaryProps {
    children: ReactNode
    /** Fallback UI (ReactNode or component receiving error + resetError) */
    fallback?: ReactNode | ComponentType<{ error: Error; resetError: () => void }>
    /** Callback after error is reported */
    onError?: (error: Error, errorInfo: ErrorInfo) => void
    /** Callback when error state is reset */
    onReset?: () => void
}

interface State {
    error: Error | null
}

export class CondevErrorBoundary extends Component<CondevErrorBoundaryProps, State> {
    constructor(props: CondevErrorBoundaryProps) {
        super(props)
        this.state = { error: null }
    }

    static getDerivedStateFromError(error: Error): State {
        return { error }
    }

    componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
        const transport = getTransport()
        if (transport) {
            transport.send({
                event_type: 'error',
                type: error.name || 'ReactRenderError',
                message: error.message,
                stack: error.stack,
                componentStack: errorInfo.componentStack,
                path: typeof window !== 'undefined' ? window.location.pathname : '',
                framework: 'react',
            })
        }
        this.props.onError?.(error, errorInfo)
    }

    resetError = (): void => {
        this.props.onReset?.()
        this.setState({ error: null })
    }

    render(): ReactNode {
        const { error } = this.state
        if (error) {
            const { fallback } = this.props
            if (typeof fallback === 'function') {
                const FallbackComponent = fallback
                return <FallbackComponent error={error} resetError={this.resetError} />
            }
            return fallback ?? null
        }
        return this.props.children
    }
}

/** HOC version of CondevErrorBoundary */
export function withErrorBoundary<P extends Record<string, unknown>>(
    WrappedComponent: ComponentType<P>,
    options?: Omit<CondevErrorBoundaryProps, 'children'>
): FC<P> {
    const WithBoundary: FC<P> = props => (
        <CondevErrorBoundary {...options}>
            <WrappedComponent {...props} />
        </CondevErrorBoundary>
    )
    WithBoundary.displayName = `withErrorBoundary(${(WrappedComponent as { displayName?: string }).displayName || WrappedComponent.name || 'Component'})`
    return WithBoundary
}
