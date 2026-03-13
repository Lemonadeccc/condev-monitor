export async function register() {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        const { BasicTracerProvider } = await import('@opentelemetry/sdk-trace-base')
        const { trace } = await import('@opentelemetry/api')
        const { initAIMonitor, VercelAIAdapter } = await import('@condev-monitor/monitor-sdk-ai')

        const adapter = new VercelAIAdapter()
        const processor = initAIMonitor({
            dsn: process.env.NEXT_PUBLIC_CONDEV_DSN!,
            adapter,
            debug: true,
        })

        const provider = new BasicTracerProvider({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            spanProcessors: [processor as any],
        })
        trace.setGlobalTracerProvider(provider)
    }
}
