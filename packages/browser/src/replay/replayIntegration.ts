import type { Transport } from '@condev-monitor/monitor-sdk-core'

import { EventType, record } from 'rrweb'

type ReplayBlockClass = string | RegExp
type ReplayBlockSelector = string

type ReplayRecordOptions = {
    inlineImages?: boolean
    collectFonts?: boolean
    recordCanvas?: boolean
    maskAllInputs?: boolean
    maskTextClass?: string
    mousemoveWait?: number
    blockClass?: ReplayBlockClass
    blockSelector?: ReplayBlockSelector
}

type ReplayUploadOptions = {
    keepalive?: boolean
    keepaliveMaxBytes?: number
    retryCount?: number
    retryDelayMs?: number
    retryBackoff?: number
}

export type ReplayOptions = {
    bufferMs?: number
    maxEvents?: number
    beforeErrorMs?: number
    afterErrorMs?: number
    record?: ReplayRecordOptions
    upload?: ReplayUploadOptions
}

type eventWithTime = {
    type: number
    timestamp: number
    data: unknown
}

type listenerHandler = () => void

type ParsedDsn = {
    appId: string
    origin: string
    basePath: string
}

function parseDsn(dsn: string): ParsedDsn | null {
    try {
        const url = new URL(dsn)
        const parts = url.pathname.split('/').filter(Boolean)
        let appId: string | undefined
        let basePath: string

        const trackingIndex = parts.indexOf('tracking')
        if (trackingIndex !== -1) {
            appId = parts[trackingIndex + 1]
            basePath = '/' + parts.slice(0, trackingIndex).join('/')
        } else {
            // Fallback: assume standard structure [ ...base, endpoint, appId ]
            // where we replace {endpoint} with 'replay' in the constructed URL later.
            if (parts.length < 2) return null
            appId = parts[parts.length - 1]
            basePath = '/' + parts.slice(0, parts.length - 2).join('/')
        }

        if (!appId) return null
        return { appId, origin: url.origin, basePath }
    } catch {
        return null
    }
}

function nowMs() {
    return Date.now()
}

export class Replay {
    private enabled = false
    private events: eventWithTime[] = []
    private bufferMs: number
    private maxEvents: number
    private beforeErrorMs: number
    private afterErrorMs: number
    private recordOptions: {
        inlineImages: boolean
        collectFonts: boolean
        recordCanvas: boolean
        maskAllInputs: boolean
        maskTextClass: string
        mousemoveWait: number
        blockClass?: ReplayBlockClass
        blockSelector?: ReplayBlockSelector
    }
    private uploadOptions: {
        keepalive: boolean
        keepaliveMaxBytes: number
        retryCount: number
        retryDelayMs: number
        retryBackoff: number
    }
    private stopRecording: listenerHandler | null = null
    private pendingUpload: null | {
        replayId: string
        errorAtMs: number
        windowStartMs: number
        windowEndMs: number
        timerId: number
        replayUploadUrl: string
    } = null

    constructor(
        private transport: Transport,
        private dsn: string,
        options?: ReplayOptions
    ) {
        const recordOptions = options?.record ?? {}
        const uploadOptions = options?.upload ?? {}

        this.beforeErrorMs = Math.max(0, options?.beforeErrorMs ?? 15_000)
        this.afterErrorMs = Math.max(0, options?.afterErrorMs ?? 10_000)
        const minBuffer = this.beforeErrorMs + this.afterErrorMs + 10_000
        this.bufferMs = Math.max(minBuffer, options?.bufferMs ?? 90_000)
        this.maxEvents = Math.max(500, options?.maxEvents ?? 3000)
        this.recordOptions = {
            inlineImages: recordOptions.inlineImages ?? true,
            collectFonts: recordOptions.collectFonts ?? true,
            recordCanvas: recordOptions.recordCanvas ?? false,
            maskAllInputs: recordOptions.maskAllInputs ?? true,
            maskTextClass: recordOptions.maskTextClass ?? 'condev-replay-mask',
            mousemoveWait: recordOptions.mousemoveWait ?? 50,
            blockClass: recordOptions.blockClass,
            blockSelector: recordOptions.blockSelector,
        }
        this.uploadOptions = {
            keepalive: uploadOptions.keepalive ?? true,
            keepaliveMaxBytes: Math.max(1024, uploadOptions.keepaliveMaxBytes ?? 60_000),
            retryCount: Math.max(0, uploadOptions.retryCount ?? 1),
            retryDelayMs: Math.max(0, uploadOptions.retryDelayMs ?? 500),
            retryBackoff: Math.max(1, uploadOptions.retryBackoff ?? 2),
        }
    }

    init() {
        void this.bootstrap()
    }

    private async bootstrap() {
        const parsed = parseDsn(this.dsn)
        if (!parsed) return

        // Query DSN server first so the browser doesn't need CORS access to the monitor backend.
        const configUrl = new URL(`${parsed.origin}${parsed.basePath}/app-config`)
        configUrl.searchParams.set('appId', parsed.appId)

        let replayEnabled = false
        try {
            const res = await fetch(configUrl.toString(), { method: 'GET' })
            if (res.ok) {
                const json = (await res.json()) as { data?: { replayEnabled?: boolean } }
                replayEnabled = Boolean(json?.data?.replayEnabled)
            }
        } catch {
            replayEnabled = false
        }

        if (!replayEnabled) return

        this.enabled = true
        this.patchTransport(parsed)
        this.startRecording()

        window.addEventListener(
            'pagehide',
            () => {
                void this.flushPending()
            },
            { capture: true }
        )
    }

    private patchTransport(parsed: ParsedDsn) {
        const originalSend = this.transport.send.bind(this.transport)
        const replayUploadUrl = new URL(`${parsed.origin}${parsed.basePath}/replay/${parsed.appId}`).toString()

        this.transport.send = (data: Record<string, unknown>) => {
            if (!this.enabled) return originalSend(data)

            if (data.event_type === 'error') {
                if (this.pendingUpload) {
                    return originalSend({ ...data, replayId: this.pendingUpload.replayId })
                }

                if (!this.pendingUpload) {
                    const replayId = `replay_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
                    const errorAtMs = nowMs()
                    const windowStartMs = Math.max(0, errorAtMs - this.beforeErrorMs)
                    const windowEndMs = errorAtMs + this.afterErrorMs

                    const timerId = window.setTimeout(() => {
                        void this.flushPending()
                    }, this.afterErrorMs)

                    this.pendingUpload = { replayId, errorAtMs, windowStartMs, windowEndMs, timerId, replayUploadUrl }
                    return originalSend({ ...data, replayId })
                }
            }

            return originalSend(data)
        }
    }

    private startRecording() {
        if (!this.enabled) return
        if (this.stopRecording) return

        // Ensure frequent full snapshots so a 15s "before error" window always has a baseline.
        this.stopRecording =
            record({
                emit: (event: eventWithTime) => this.push(event),
                checkoutEveryNms: 10_000,
                maskAllInputs: this.recordOptions.maskAllInputs,
                maskTextClass: this.recordOptions.maskTextClass,
                recordCanvas: this.recordOptions.recordCanvas,
                inlineImages: this.recordOptions.inlineImages,
                collectFonts: this.recordOptions.collectFonts,
                mousemoveWait: this.recordOptions.mousemoveWait,
                blockClass: this.recordOptions.blockClass,
                blockSelector: this.recordOptions.blockSelector,
            }) ?? null
    }

    private push(event: eventWithTime) {
        const cutoff = event.timestamp - this.bufferMs
        this.events.push(event)

        while (this.events.length > this.maxEvents) this.events.shift()
        while (this.events.length && (this.events[0]?.timestamp ?? 0) < cutoff) this.events.shift()
    }

    private findMetaEvent(beforeTimestamp: number) {
        for (let i = this.events.length - 1; i >= 0; i -= 1) {
            const e = this.events[i]
            if (!e) continue
            if (e.type === EventType.Meta && e.timestamp <= beforeTimestamp) return e
        }
        for (let i = this.events.length - 1; i >= 0; i -= 1) {
            const e = this.events[i]
            if (!e) continue
            if (e.type === EventType.Meta) return e
        }
        return null
    }

    private withMetaFirst(events: eventWithTime[], headTimestamp: number) {
        if (events.length === 0) return events
        if (events[0]?.type === EventType.Meta) return events

        const meta = this.findMetaEvent(headTimestamp)
        if (!meta) return events

        const adjustedTimestamp = Math.min(meta.timestamp, headTimestamp - 1)
        const metaEvent = adjustedTimestamp === meta.timestamp ? meta : { ...meta, timestamp: adjustedTimestamp }
        return [metaEvent, ...events]
    }

    private pickEvents(windowStartMs: number, windowEndMs: number) {
        const fullSnapshotIndex = (() => {
            for (let i = this.events.length - 1; i >= 0; i -= 1) {
                const e = this.events[i]
                if (!e) continue
                if (e.type === EventType.FullSnapshot && e.timestamp <= windowStartMs) return i
            }
            for (let i = 0; i < this.events.length; i += 1) {
                const e = this.events[i]
                if (e?.type === EventType.FullSnapshot) return i
            }
            return 0
        })()

        const baseStartMs = this.events[fullSnapshotIndex]?.timestamp ?? windowStartMs
        const base = this.events.filter(e => e.timestamp >= baseStartMs && e.timestamp <= windowEndMs)

        // rrweb replay expects a Meta + FullSnapshot header (Meta = 0, FullSnapshot = 2).
        const firstFullSnapshotIdx = base.findIndex(e => e.type === EventType.FullSnapshot)
        if (firstFullSnapshotIdx === -1) {
            const picked = base.slice(-this.maxEvents)
            const startedAtMs = picked[0]?.timestamp ?? baseStartMs
            const normalized = this.withMetaFirst(picked, startedAtMs)
            return { startedAtMs: normalized[0]?.timestamp ?? startedAtMs, events: normalized }
        }

        const head = base[firstFullSnapshotIdx]!
        const tail = base.slice(firstFullSnapshotIdx + 1)
        const trimmed = tail.length > this.maxEvents - 1 ? tail.slice(-(this.maxEvents - 1)) : tail

        const picked = [head, ...trimmed]
        const normalized = this.withMetaFirst(picked, head.timestamp)
        return { startedAtMs: normalized[0]?.timestamp ?? head.timestamp, events: normalized }
    }

    private async flushPending() {
        if (!this.pendingUpload) return

        const pending = this.pendingUpload
        this.pendingUpload = null
        if (pending.timerId) window.clearTimeout(pending.timerId)

        const { startedAtMs, events } = this.pickEvents(pending.windowStartMs, pending.windowEndMs)
        const endedAtMs = Math.min(nowMs(), pending.windowEndMs)

        try {
            await this.postReplay(pending.replayUploadUrl, {
                replayId: pending.replayId,
                startedAt: new Date(startedAtMs).toISOString(),
                endedAt: new Date(endedAtMs).toISOString(),
                errorAt: new Date(pending.errorAtMs).toISOString(),
                url: location.href,
                path: location.pathname,
                userAgent: navigator.userAgent,
                events,
            })
        } catch {
            // ignore
        }
    }

    private shouldRetry(status: number) {
        if (status === 408 || status === 429) return true
        return status >= 500 && status <= 599
    }

    private async postReplay(url: string, payload: Record<string, unknown>) {
        const body = JSON.stringify(payload)
        const keepalive = this.uploadOptions.keepalive && body.length <= this.uploadOptions.keepaliveMaxBytes
        const retryCount = this.uploadOptions.retryCount
        let delayMs = this.uploadOptions.retryDelayMs
        const backoff = this.uploadOptions.retryBackoff

        for (let attempt = 0; attempt <= retryCount; attempt += 1) {
            try {
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body,
                    keepalive,
                })
                if (res.ok) return
                if (!this.shouldRetry(res.status) || attempt === retryCount) return
            } catch {
                if (attempt === retryCount) return
            }

            if (delayMs > 0) {
                await new Promise(resolve => window.setTimeout(resolve, delayMs))
                delayMs *= backoff
            }
        }
    }

    stop() {
        if (this.pendingUpload?.timerId) window.clearTimeout(this.pendingUpload.timerId)
        this.pendingUpload = null
        if (this.stopRecording) this.stopRecording()
        this.stopRecording = null
        this.events = []
        this.enabled = false
    }
}
