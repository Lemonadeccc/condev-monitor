import { Transport } from './transport'
import { MonitoringOptions } from './types'

export let getTransport: () => Transport | null = () => null

// ---- User context ----

export interface UserContext {
    id?: string
    email?: string
    [key: string]: unknown
}

let _user: UserContext | null = null

export function setUser(user: UserContext | null): void {
    _user = user
}

export function getUser(): UserContext | null {
    return _user
}

export function clearUser(): void {
    _user = null
}

export class Monitoring {
    private transport: Transport | null = null

    constructor(private options: MonitoringOptions) {}

    init(transport: Transport) {
        this.transport = transport
        getTransport = () => transport
        this.options.integrations?.forEach(integration => {
            integration.init(transport)
        })
    }

    // reportMessage(message: string) {
    //     this.transport?.send({ type: 'message', message })
    // }

    // reportEvent(event: unknown) {
    //     this.transport?.send({ type: 'event', event })
    // }
}
