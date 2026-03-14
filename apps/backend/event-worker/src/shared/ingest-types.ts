export type EventRow = {
    event_id: string
    app_id: string
    event_type: string
    fingerprint: string
    message: string
    info: Record<string, unknown>
    sdk_version: string
    environment: string
    release: string
}

export type KafkaEventEnvelope = {
    schemaVersion: number
    eventId: string
    appId: string
    eventType: string
    message: string
    info: Record<string, unknown>
    sdkVersion?: string
    environment?: string
    release?: string
    receivedAt: string
    source: string
}
