export interface Transport {
    send(data: Record<string, unknown>): void
    flush?(): void | Promise<void>
    destroy?(): void | Promise<void>
}
