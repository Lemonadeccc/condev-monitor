import { Transport } from './transport'

export type MonitorIntegrationTeardown = () => void | Promise<void>

/**
 * Public, structural integration contract. Implementations do not need to
 * extend an SDK base class, which keeps framework and feature packages loosely
 * coupled to core.
 */
export interface MonitorIntegration {
    readonly name: string
    /** Returned teardown is used when destroy() is not provided. */
    setup(transport: Transport): void | MonitorIntegrationTeardown
    flush?(): void | Promise<void>
    destroy?(): void | Promise<void>
}

/** @deprecated Implement {@link MonitorIntegration} with setup() instead. */
export interface IIntegration {
    readonly name?: string
    init(transport: Transport): void
    flush?(): void | Promise<void>
    destroy?(): void | Promise<void>
}

export type IntegrationLike = MonitorIntegration | IIntegration

/**
 * Legacy base class retained for compatibility. New integrations should use
 * the structural MonitorIntegration interface instead.
 */
export class Integration implements IIntegration {
    constructor(private callback: () => void) {}

    transport: Transport | null = null

    init(transport: Transport): void {
        this.transport = transport
    }
}

export interface MonitoringOptions {
    dsn: string
    integrations?: IntegrationLike[]
}
