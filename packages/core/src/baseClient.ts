import { Transport } from './transport'
import { IIntegration, IntegrationLike, MonitoringOptions, MonitorIntegration, MonitorIntegrationTeardown } from './types'

let activeTransport: Transport | null = null

export const getTransport = (): Transport | null => activeTransport

// ---- User context ----

export interface UserContext {
    id?: string
    email?: string
    [key: string]: unknown
}

let activeUser: UserContext | null = null

export function setUser(user: UserContext | null): void {
    activeUser = user
}

export function getUser(): UserContext | null {
    return activeUser
}

export function clearUser(): void {
    activeUser = null
}

export class Monitoring {
    private transport: Transport | null = null
    private readonly integrations: IntegrationLike[]
    private activeIntegrations: Array<{ integration: IntegrationLike; teardown?: MonitorIntegrationTeardown }> = []
    private initialized = false
    private destroyed = false
    private destroyPromise: Promise<void> | null = null

    constructor(private options: MonitoringOptions) {
        this.integrations = [...(options.integrations ?? [])]
    }

    init(transport: Transport): this {
        if (this.initialized || this.destroyed) return this
        this.transport = transport
        this.initialized = true
        activeTransport = transport

        for (const integration of this.integrations) {
            let teardown: void | MonitorIntegrationTeardown = undefined
            const activeIntegration: { integration: IntegrationLike; teardown?: MonitorIntegrationTeardown } = { integration }
            this.activeIntegrations.push(activeIntegration)
            const legacyIntegration = integration as Partial<IIntegration>
            const structuralIntegration = integration as Partial<MonitorIntegration>
            // `init` was the original public contract. Prefer it when both are
            // present so existing integrations do not silently switch hooks.
            if (typeof legacyIntegration.init === 'function') legacyIntegration.init(transport)
            else if (typeof structuralIntegration.setup === 'function') teardown = structuralIntegration.setup(transport)
            activeIntegration.teardown = teardown ?? undefined
        }

        return this
    }

    getIntegration<T extends IntegrationLike = IntegrationLike>(name: string): T | undefined {
        return this.integrations.find(integration => integration.name === name) as T | undefined
    }

    async flush(): Promise<void> {
        if (!this.initialized || this.destroyed) return
        const failure = await this.finalizeAndFlushTransport()
        if (failure !== undefined) throw failure
    }

    destroy(): Promise<void> {
        if (this.destroyPromise) return this.destroyPromise
        const attempt = this.performDestroy()
        this.destroyPromise = attempt
        void attempt.catch(() => {
            if (!this.destroyed && this.destroyPromise === attempt) this.destroyPromise = null
        })
        return attempt
    }

    /**
     * Cleans a partially initialized client without flushing telemetry. The
     * caller must keep its singleton slot reserved until this promise settles.
     */
    protected abortInitialization(): Promise<void> {
        if (this.destroyPromise) return this.destroyPromise
        const attempt = this.performInitializationAbort()
        this.destroyPromise = attempt
        return attempt
    }

    isDestroyed(): boolean {
        return this.destroyed
    }

    private async finalizeAndFlushTransport(): Promise<unknown | undefined> {
        let failure: unknown | undefined

        for (const { integration } of this.activeIntegrations) {
            try {
                await integration.flush?.()
            } catch (error) {
                failure ??= error
            }
        }

        try {
            await this.transport?.flush?.()
        } catch (error) {
            failure ??= error
        }

        return failure
    }

    private async performDestroy(): Promise<void> {
        if (this.destroyed) return

        let failure = await this.finalizeAndFlushTransport()
        if (failure !== undefined) throw failure

        for (const { integration, teardown } of [...this.activeIntegrations].reverse()) {
            try {
                if (typeof integration.destroy === 'function') await integration.destroy()
                else await teardown?.()
            } catch (error) {
                failure ??= error
            }
        }

        const transport = this.transport
        try {
            // A teardown may enqueue its final event. Drain once more before
            // destroying the transport so lifecycle data is not stranded.
            await transport?.flush?.()
        } catch (error) {
            failure ??= error
        }
        try {
            await transport?.destroy?.()
        } catch (error) {
            failure ??= error
        }

        this.activeIntegrations = []
        this.transport = null
        this.destroyed = true
        if (activeTransport === transport) activeTransport = null

        if (failure !== undefined) throw failure
    }

    private async performInitializationAbort(): Promise<void> {
        if (this.destroyed) return

        let failure: unknown | undefined
        for (const { integration, teardown } of [...this.activeIntegrations].reverse()) {
            try {
                if (typeof integration.destroy === 'function') await integration.destroy()
                else await teardown?.()
            } catch (error) {
                failure ??= error
            }
        }

        const transport = this.transport
        try {
            await transport?.destroy?.()
        } catch (error) {
            failure ??= error
        }

        this.activeIntegrations = []
        this.transport = null
        this.destroyed = true
        if (activeTransport === transport) activeTransport = null

        if (failure !== undefined) throw failure
    }

    // reportMessage(message: string) {
    //     this.transport?.send({ type: 'message', message })
    // }

    // reportEvent(event: unknown) {
    //     this.transport?.send({ type: 'event', event })
    // }
}
