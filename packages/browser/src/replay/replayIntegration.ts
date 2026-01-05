import type { Transport } from '@condev-monitor/monitor-sdk-core'

import { EventType, record } from 'rrweb'

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
        const trackingIndex = parts.indexOf('tracking')
        if (trackingIndex === -1) return null
        const appId = parts[trackingIndex + 1]
        if (!appId) return null
        const basePath = '/' + parts.slice(0, trackingIndex).join('/')
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
        options?: {
            bufferMs?: number
            maxEvents?: number
            beforeErrorMs?: number
            afterErrorMs?: number
        }
    ) {
        this.beforeErrorMs = Math.max(0, options?.beforeErrorMs ?? 15_000)
        this.afterErrorMs = Math.max(0, options?.afterErrorMs ?? 10_000)
        const minBuffer = this.beforeErrorMs + this.afterErrorMs + 10_000
        this.bufferMs = Math.max(minBuffer, options?.bufferMs ?? 90_000)
        this.maxEvents = Math.max(500, options?.maxEvents ?? 3000)
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
                // privacy defaults
                maskAllInputs: true,
                maskTextClass: 'condev-replay-mask',
                // perf defaults
                recordCanvas: false,
                inlineImages: true,
                collectFonts: true,
                mousemoveWait: 50,
            }) ?? null
    }

    private push(event: eventWithTime) {
        const cutoff = event.timestamp - this.bufferMs
        this.events.push(event)

        while (this.events.length > this.maxEvents) this.events.shift()
        while (this.events.length && (this.events[0]?.timestamp ?? 0) < cutoff) this.events.shift()
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

        // rrweb replay requires a FullSnapshot as the first event.
        const firstFullSnapshotIdx = base.findIndex(e => e.type === EventType.FullSnapshot)
        if (firstFullSnapshotIdx === -1) {
            return { startedAtMs: baseStartMs, events: base.slice(-this.maxEvents) }
        }

        const head = base[firstFullSnapshotIdx]!
        const tail = base.slice(firstFullSnapshotIdx + 1)
        const trimmed = tail.length > this.maxEvents - 1 ? tail.slice(-(this.maxEvents - 1)) : tail

        return { startedAtMs: head.timestamp, events: [head, ...trimmed] }
    }

    private async flushPending() {
        if (!this.pendingUpload) return

        const pending = this.pendingUpload
        this.pendingUpload = null
        if (pending.timerId) window.clearTimeout(pending.timerId)

        const { startedAtMs, events } = this.pickEvents(pending.windowStartMs, pending.windowEndMs)
        const endedAtMs = Math.min(nowMs(), pending.windowEndMs)

        try {
            await fetch(pending.replayUploadUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    replayId: pending.replayId,
                    startedAt: new Date(startedAtMs).toISOString(),
                    endedAt: new Date(endedAtMs).toISOString(),
                    errorAt: new Date(pending.errorAtMs).toISOString(),
                    url: location.href,
                    path: location.pathname,
                    userAgent: navigator.userAgent,
                    events,
                }),
            })
        } catch {
            // ignore
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
