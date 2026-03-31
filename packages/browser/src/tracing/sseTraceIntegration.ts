import type { Transport } from '@condev-monitor/monitor-sdk-core'
import { parseDsn } from '@condev-monitor/monitor-sdk-core'
import type { SSETraceOptions } from './sseTraceTypes'
import { DEFAULT_SSE_TRACE_OPTIONS } from './sseTraceTypes'

const PATCHED = Symbol.for('condev-sse-trace')

export class SSETraceIntegration {
    private readonly cfg: Required<SSETraceOptions>
    private readonly normalizedDsnUrl: string

    constructor(
        private transport: Transport,
        dsnUrl: string,
        options?: SSETraceOptions
    ) {
        this.cfg = { ...DEFAULT_SSE_TRACE_OPTIONS, ...options }
        const parsed = parseDsn(dsnUrl)
        this.normalizedDsnUrl = parsed ? `${parsed.origin}${parsed.basePath}/tracking/${parsed.appId}` : dsnUrl
    }

    init(): void {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((window.fetch as any)[PATCHED]) return
        const prevFetch = window.fetch
        const self = this

        const patchedFetch = function (_this: unknown, input: RequestInfo | URL, init?: RequestInit) {
            const url = resolveUrl(input)

            if (self.isExcluded(url)) {
                return prevFetch.call(_this, input, init)
            }

            const hasPatterns = self.cfg.urlPatterns.length > 0
            if (hasPatterns && !self.matchesUrl(url)) {
                return prevFetch.call(_this, input, init)
            }

            const traceId = genTraceId()
            const method = extractMethod(input, init)

            // Only inject trace header when urlPatterns explicitly matched this request.
            // In auto-detect mode (urlPatterns=[]), never inject — avoids polluting
            // unrelated same-origin requests with cache-busting / auth-breaking headers.
            let tracedInit = init
            if (hasPatterns && self.cfg.injectTraceId && self.canInjectTraceHeader(url)) {
                const baseHeaders = input instanceof Request && init?.headers === undefined ? input.headers : init?.headers
                const headers = new Headers(baseHeaders ?? {})
                headers.set(self.cfg.traceIdHeader, traceId)
                tracedInit = { ...init, headers }
            }

            const startedPerf = performance.now()
            const startedAt = Math.round(performance.timeOrigin + startedPerf)

            return prevFetch
                .call(_this, input, tracedInit)
                .then(async (response: Response) => {
                    try {
                        const ct = response.headers.get('content-type') ?? ''
                        const isCandidate = ct.includes('text/event-stream') || hasPatterns
                        if (!isCandidate) return response

                        if (!response.ok) {
                            const httpError = await extractHttpErrorPayload(response)
                            self.emitFailure({
                                traceId,
                                url: response.url || url,
                                method,
                                status: response.status,
                                failureStage: 'http',
                                error: httpError,
                                responseContentType: ct,
                                startedPerf,
                                startedAt,
                            })
                            return response
                        }

                        if (!response.body) return response

                        // clone() preserves original response (url, redirected, etc.) for the caller
                        const probeClone = response.clone()
                        if (!probeClone.body) return response

                        void self.probe(probeClone.body, {
                            traceId,
                            url: response.url || url,
                            method,
                            status: response.status,
                            startedPerf,
                            startedAt,
                        })
                    } catch {
                        // Never let probe setup fail the caller's fetch
                    }
                    return response
                })
                .catch((error: unknown) => {
                    if (hasPatterns) {
                        try {
                            self.emitFailure({
                                traceId,
                                url,
                                method,
                                status: 0,
                                failureStage: 'network',
                                error,
                                responseContentType: null,
                                startedPerf,
                                startedAt,
                            })
                        } catch {
                            // Never let failure telemetry break the caller's fetch
                        }
                    }
                    throw error
                })
        }

        window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
            return patchedFetch(this, input, init)
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Object.defineProperty(window.fetch, PATCHED, { value: true })
    }

    // ---- failure telemetry ----

    private emitFailure(meta: {
        traceId: string
        url: string
        method: string
        status: number
        failureStage: 'http' | 'network'
        error: unknown
        responseContentType: string | null
        startedPerf: number
        startedAt: number
    }): void {
        const endedPerf = performance.now()
        this.transport.send({
            event_type: 'ai_streaming',
            type: 'sse_network',
            layer: 'network',
            traceId: meta.traceId,
            url: stripQueryAndFragment(meta.url),
            method: meta.method,
            status: meta.status,
            sseTtfb: -1,
            sseTtlb: endedPerf - meta.startedPerf,
            stallCount: 0,
            stallTotalMs: 0,
            maxChunkInterval: 0,
            chunkCount: 0,
            totalBytes: 0,
            aborted: isAbortError(meta.error),
            failureStage: meta.failureStage,
            completionReason:
                meta.failureStage === 'http'
                    ? 'http_error'
                    : meta.failureStage === 'network'
                      ? isAbortError(meta.error)
                          ? 'aborted'
                          : 'network_error'
                      : null,
            errorName: extractErrorName(meta.error),
            errorMessage: extractErrorMessage(meta.error),
            responseContentType: meta.responseContentType,
            phases: readResourceTiming(meta.url, meta.startedPerf),
            startedAt: meta.startedAt,
            endedAt: Math.round(performance.timeOrigin + endedPerf),
            path: window.location.pathname,
            at: Date.now(),
        })
    }

    // ---- stream probe ----

    private async probe(
        stream: ReadableStream<Uint8Array>,
        meta: {
            traceId: string
            url: string
            method: string
            status: number
            startedPerf: number
            startedAt: number
        }
    ): Promise<void> {
        const reader = stream.getReader()
        let firstChunkAt = 0
        let lastChunkAt = meta.startedPerf
        let chunkCount = 0
        let totalBytes = 0
        let stallCount = 0
        let stallTotalMs = 0
        let maxGap = 0
        let streamError: unknown = null
        let aborted = false

        try {
            while (true) {
                const { done, value } = await reader.read()
                if (done) break

                const now = performance.now()
                if (chunkCount === 0) firstChunkAt = now

                const gap = now - lastChunkAt
                if (gap > maxGap) maxGap = gap
                if (chunkCount > 0 && gap > this.cfg.stallThresholdMs) {
                    stallCount++
                    stallTotalMs += gap
                }

                lastChunkAt = now
                chunkCount++
                totalBytes += value?.byteLength ?? 0

                if (chunkCount >= this.cfg.maxProbeChunks || totalBytes >= this.cfg.maxProbeBytes) {
                    aborted = true
                    break
                }
            }
        } catch (err: unknown) {
            streamError = err
            aborted = true
        } finally {
            if (aborted) {
                try {
                    await reader.cancel()
                } catch {
                    /* ignore */
                }
            }
            reader.releaseLock()

            const endedPerf = performance.now()
            const endedAt = Math.round(performance.timeOrigin + endedPerf)

            this.transport.send({
                event_type: 'ai_streaming',
                type: 'sse_network',
                layer: 'network',
                traceId: meta.traceId,
                url: stripQueryAndFragment(meta.url),
                method: meta.method,
                status: meta.status,
                sseTtfb: firstChunkAt ? firstChunkAt - meta.startedPerf : -1,
                sseTtlb: endedPerf - meta.startedPerf,
                stallCount,
                stallTotalMs,
                maxChunkInterval: maxGap,
                chunkCount,
                totalBytes,
                aborted,
                failureStage: streamError ? 'stream' : null,
                completionReason: streamError ? 'stream_error' : aborted ? 'probe_limit' : 'complete',
                errorName: extractErrorName(streamError),
                errorMessage: extractErrorMessage(streamError),
                responseContentType: null,
                phases: readResourceTiming(meta.url, meta.startedPerf),
                startedAt: meta.startedAt,
                endedAt,
                path: window.location.pathname,
                at: Date.now(),
            })
        }
    }

    // ---- helpers ----

    private isExcluded(url: string): boolean {
        if (url.includes(this.normalizedDsnUrl)) return true
        return this.cfg.excludeUrls.some(p => (typeof p === 'string' ? url.includes(p) : p.test(url)))
    }

    private matchesUrl(url: string): boolean {
        return this.cfg.urlPatterns.some(p => (typeof p === 'string' ? url.includes(p) : p.test(url)))
    }

    private isSameOrigin(url: string): boolean {
        try {
            return new URL(url, window.location.origin).origin === window.location.origin
        } catch {
            return false
        }
    }

    private canInjectTraceHeader(url: string): boolean {
        if (this.isSameOrigin(url)) return true

        try {
            const targetOrigin = new URL(url, window.location.origin).origin
            return this.cfg.traceHeaderOrigins.some(origin => {
                try {
                    return new URL(origin, window.location.origin).origin === targetOrigin
                } catch {
                    return false
                }
            })
        } catch {
            return false
        }
    }
}

// ---- module-level utilities (no allocation per call) ----

function resolveUrl(input: RequestInfo | URL): string {
    if (typeof input === 'string') {
        try {
            return new URL(input, window.location.origin).href
        } catch {
            return input
        }
    }
    if (input instanceof URL) return input.href
    return input.url
}

function extractMethod(input: RequestInfo | URL, init?: RequestInit): string {
    if (init?.method) return init.method
    if (typeof input !== 'string' && !(input instanceof URL)) return input.method
    return 'GET'
}

function genTraceId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID()
    }
    return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

function stripQueryAndFragment(url: string): string {
    try {
        const u = new URL(url)
        return u.origin + u.pathname
    } catch {
        return url.split('?')[0]!.split('#')[0]!
    }
}

function readResourceTiming(url: string, startedPerf: number): Record<string, number> | undefined {
    try {
        const entries = performance.getEntriesByName(url, 'resource') as PerformanceResourceTiming[]
        // Pick the entry closest to our fetch start time (handles concurrent same-URL requests)
        const e = entries.reduce<PerformanceResourceTiming | undefined>((best, entry) => {
            if (!best) return entry
            return Math.abs(entry.startTime - startedPerf) < Math.abs(best.startTime - startedPerf) ? entry : best
        }, undefined)
        if (!e) return undefined
        return {
            dns: e.domainLookupEnd - e.domainLookupStart,
            tcp: e.connectEnd - e.connectStart,
            tls: e.secureConnectionStart > 0 ? e.connectEnd - e.secureConnectionStart : 0,
            request: e.responseStart - e.requestStart,
            response: e.responseEnd - e.responseStart,
        }
    } catch {
        return undefined
    }
}

function extractErrorName(error: unknown): string | null {
    if (error instanceof Error) return error.name || null
    if (typeof error === 'object' && error !== null && 'name' in error) {
        const name = (error as { name?: unknown }).name
        return typeof name === 'string' && name ? name : null
    }
    return null
}

function extractErrorMessage(error: unknown): string | null {
    if (error instanceof Error) return error.message || null
    if (typeof error === 'string' && error) return error
    if (typeof error === 'object' && error !== null && 'message' in error) {
        const message = (error as { message?: unknown }).message
        return typeof message === 'string' && message ? message : null
    }
    return null
}

function isAbortError(error: unknown): boolean {
    if (error instanceof DOMException) return error.name === 'AbortError'
    return extractErrorName(error) === 'AbortError'
}

async function extractHttpErrorPayload(response: Response): Promise<unknown> {
    const ct = response.headers.get('content-type') ?? ''
    const clone = response.clone()
    try {
        if (ct.includes('application/json')) {
            const body = (await clone.json()) as {
                error?: { code?: unknown; message?: unknown }
            }
            const code = typeof body?.error?.code === 'string' ? body.error.code : undefined
            const message = typeof body?.error?.message === 'string' ? body.error.message : undefined
            if (code || message) return { name: code, message }
        }
        if (ct.startsWith('text/')) {
            const text = (await clone.text()).trim()
            if (text) return { message: text.slice(0, 512) }
        }
    } catch {
        // ignore parse failures — never break caller's fetch
    }
    return null
}
