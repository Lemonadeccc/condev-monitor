import { init } from '@condev-monitor/monitor-sdk-browser/animation'

const development = process.env.NODE_ENV !== 'production'
const dsn = process.env.NEXT_PUBLIC_MONITOR_DSN?.trim()

init({
    dsn,
    animation: {
        autoStart: development || Boolean(dsn),
        devtools: development,
        rum: dsn ? { contractVersion: 2, sampleRate: 1 } : false,
        context: {
            routeKey: 'silencio.home',
            environment: development ? 'development' : 'production',
            runtimeFamily: 'three',
        },
    },
})
