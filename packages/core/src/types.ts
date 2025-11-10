import { Transport } from './transport'

export interface IIntegration {
    init(transport: Transport): void
}

export class Integration implements IIntegration {
    transport: Transport | null = null

    init(transport: Transport): void {
        this.transport = transport
    }
}

export interface MonitoringOptions {
    dsn: string
    integrations?: Integration[]
}
