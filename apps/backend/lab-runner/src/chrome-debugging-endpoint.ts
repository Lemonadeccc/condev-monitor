export interface ChromeDebuggingEndpointOptions {
    timeoutMs?: number
    retryMs?: number
    fetchImpl?: typeof fetch
    description?: string
}

function validWebSocket(value: unknown, port: number): string | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const webSocketDebuggerUrl = (value as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl
    if (typeof webSocketDebuggerUrl !== 'string') return undefined
    try {
        const url = new URL(webSocketDebuggerUrl)
        return url.protocol === 'ws:' &&
            (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1' || url.hostname === '[::1]') &&
            Number(url.port) === port &&
            url.pathname.startsWith('/devtools/browser/')
            ? url.href
            : undefined
    } catch {
        return undefined
    }
}

export async function waitForChromeDebuggingEndpoint(port: number, options: ChromeDebuggingEndpointOptions = {}): Promise<string> {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new TypeError('Invalid Chrome debugging port')
    const timeoutMs = options.timeoutMs ?? 5_000
    const retryMs = options.retryMs ?? 100
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
        throw new TypeError('Invalid Chrome debugging readiness timeout')
    }
    if (!Number.isSafeInteger(retryMs) || retryMs < 1 || retryMs > 1_000) {
        throw new TypeError('Invalid Chrome debugging readiness retry interval')
    }
    const request = options.fetchImpl ?? fetch
    const endpoint = `http://127.0.0.1:${port}/json/version`
    const deadline = Date.now() + timeoutMs
    do {
        try {
            const remainingMs = Math.max(1, deadline - Date.now())
            const response = await request(endpoint, {
                redirect: 'error',
                signal: AbortSignal.timeout(Math.min(1_000, remainingMs)),
            })
            if (response.ok) {
                const webSocketUrl = validWebSocket(await response.json(), port)
                if (webSocketUrl) return webSocketUrl
            }
        } catch {
            // Chrome can accept its port before the browser DevTools endpoint is ready.
        }
        const remainingMs = deadline - Date.now()
        if (remainingMs <= 0) break
        await new Promise(resolve => setTimeout(resolve, Math.min(retryMs, remainingMs)))
    } while (Date.now() < deadline)
    throw new Error(`${options.description ?? 'Chrome'} debugging endpoint did not become ready`)
}
