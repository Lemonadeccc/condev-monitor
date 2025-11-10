import { Transport } from '../transport'

export class Errors {
    transport: Transport

    constructor(transport: Transport) {
        this.transport = transport
    }

    init() {
        window.onerror = (message, source, line, column, error) => {
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
