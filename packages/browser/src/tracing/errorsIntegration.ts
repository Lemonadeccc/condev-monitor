import { Transport } from '@condev-monitor/monitor-sdk-core'

export interface OnUnhandledRejectionErrorPayload {
    type: string
    stack: string
    message: string
    path: string
}

export class Errors {
    transport: Transport
    constructor(transport: Transport) {
        this.transport = transport
    }

    init() {
        const onError = (event: Event) => {
            // Resource loading error (img/script/link/audio/video, etc.)
            const target = event.target
            if (target && target !== window && target instanceof HTMLElement) {
                const resourceTarget = target as HTMLElement & { src?: string; href?: string; currentSrc?: string }
                const url = resourceTarget.currentSrc || resourceTarget.src || resourceTarget.href
                if (!url) return

                this.transport.send({
                    event_type: 'error',
                    type: 'resource',
                    message: `Failed to load resource: ${url}`,
                    tagName: resourceTarget.tagName?.toLowerCase?.() ?? '',
                    url,
                    path: window.location.pathname,
                })
                return
            }

            const errorEvent = event as ErrorEvent
            this.transport.send({
                event_type: 'error',
                type: errorEvent.error?.name ?? 'Error',
                stack: errorEvent.error?.stack,
                message: errorEvent.message ?? 'Script error.',
                filename: errorEvent.filename,
                lineno: errorEvent.lineno,
                colno: errorEvent.colno,
                path: window.location.pathname,
            })
        }

        window.addEventListener('error', onError as unknown as EventListener, true)

        window.addEventListener('unhandledrejection', event => {
            const reason = event.reason as { stack?: string; message?: string } | unknown
            const stack = typeof reason === 'object' && reason !== null ? (reason as { stack?: string }).stack : undefined
            const message =
                typeof reason === 'object' && reason !== null
                    ? (reason as { message?: string }).message
                    : typeof reason === 'string'
                      ? reason
                      : 'Unhandled promise rejection'

            this.transport.send({
                event_type: 'error',
                type: 'unhandledrejection',
                stack,
                message,
                path: window.location.pathname,
            })
        })
    }
}
