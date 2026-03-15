export async function register() {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        const { registerCondevServer } = await import('@condev-monitor/nextjs/server')
        await registerCondevServer({ debug: true })
    }
}
