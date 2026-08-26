import type { RawTraceEvent } from '@condev-monitor/animation-lab'
import type { CDPSession } from 'playwright-core'

const TRACE_CATEGORIES = [
    'blink.console',
    'blink.user_timing',
    'devtools.timeline',
    'disabled-by-default-devtools.timeline',
    'disabled-by-default-devtools.timeline.frame',
    'disabled-by-default-devtools.timeline.stack',
    'disabled-by-default-v8.cpu_profiler',
    'disabled-by-default-v8.cpu_profiler.hires',
    'loading',
    'toplevel',
    'v8',
].join(',')

const MAX_RAW_TRACE_BYTES = 256 * 1024 * 1024

async function readStream(client: CDPSession, handle: string): Promise<string> {
    let result = ''
    try {
        while (true) {
            const chunk = (await client.send('IO.read', { handle })) as { data?: string; base64Encoded?: boolean; eof?: boolean }
            if (chunk.data) result += chunk.base64Encoded ? Buffer.from(chunk.data, 'base64').toString('utf8') : chunk.data
            if (Buffer.byteLength(result, 'utf8') > MAX_RAW_TRACE_BYTES) {
                throw new RangeError(`Chrome trace exceeds ${MAX_RAW_TRACE_BYTES} bytes`)
            }
            if (chunk.eof) break
        }
    } finally {
        await client.send('IO.close', { handle }).catch(() => undefined)
    }
    return result
}

export async function startTrace(
    client: CDPSession,
    screenshots: boolean
): Promise<() => Promise<{ raw: string; events: RawTraceEvent[] }>> {
    await client.send('Tracing.start', {
        categories: `${TRACE_CATEGORIES}${screenshots ? ',disabled-by-default-devtools.screenshot' : ''}`,
        transferMode: 'ReturnAsStream',
        options: 'sampling-frequency=10000',
    })
    const completion = new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Chrome tracing did not complete in time')), 120_000)
        client.once('Tracing.tracingComplete', async event => {
            clearTimeout(timeout)
            const handle = (event as { stream?: string }).stream
            if (!handle) return reject(new Error('Chrome trace stream is unavailable'))
            try {
                resolve(await readStream(client, handle))
            } catch (error) {
                reject(error)
            }
        })
    })
    let stopping: Promise<{ raw: string; events: RawTraceEvent[] }> | null = null
    return async () => {
        if (!stopping) {
            stopping = (async () => {
                await client.send('Tracing.end')
                const raw = await completion
                const parsed = JSON.parse(raw) as { traceEvents?: RawTraceEvent[] }
                return { raw, events: Array.isArray(parsed.traceEvents) ? parsed.traceEvents : [] }
            })()
        }
        return stopping
    }
}
