import { init } from '@condev-monitor/react/animation'

const development = process.env.NODE_ENV !== 'production'
const dsn = process.env.NEXT_PUBLIC_MONITOR_DSN?.trim()

export const condevClient = init({
    dsn,
    animation: {
        autoStart: development || Boolean(dsn),
        devtools: development,
        rum: dsn ? { contractVersion: 2, sampleRate: 1 } : false,
        context: {
            routeKey: 'aegis.home',
            environment: development ? 'development' : 'production',
            runtimeFamily: 'three',
        },
    },
})
