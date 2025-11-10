import { Transport } from '@condev-monitor/monitor-sdk-core'

export class Errors {
    transport: Transport
    constructor(transport: Transport) {
        this.transport = transport
    }

    init() {
        window.onerror = (message, source, line, column, error) => {
            console.log('ERRORS INIT MESSAGE,source:', message, source)
            this.transport.send({
                event_type: 'error',
                type: error?.name,
                stack: error?.stack,
                message,
                path: window.location.pathname,
            })
        }

        window.onunhandledrejection = event => {
            this.transport.send({
                event_type: 'error',
                type: 'unhandledrejection',
                stack: event.reason.stack,
                message: event.reason.message,
                path: window.location.pathname,
            })
        }
    }
}
