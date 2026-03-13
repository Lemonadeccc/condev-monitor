// 'use client'
// import { useEffect } from 'react'

// export function MonitorInit() {
//     useEffect(() => {
//         import('@condev-monitor/monitor-sdk-browser').then(({ init }) => {
//             init({
//                 dsn: process.env.NEXT_PUBLIC_CONDEV_DSN!,
//                 aiStreaming: {
//                     urlPatterns: ['/api/chat'],
//                     stallThresholdMs: 3000,
//                 },
//             })
//         })
//     }, [])
//     return null
// }

'use client'
import { useEffect } from 'react'

export function MonitorInit() {
    useEffect(() => {
        import('@condev-monitor/monitor-sdk-browser').then(({ init, setUser }) => {
            init({
                dsn: process.env.NEXT_PUBLIC_CONDEV_DSN!,
                aiStreaming: {
                    urlPatterns: ['/api/chat'],
                    stallThresholdMs: 3000,
                },
                replay: true,
            })
            setUser({ id: 'dev-tester', email: 'dev@test.com' })
        })
    }, [])
    return null
}
