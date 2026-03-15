import { registerCondevClient } from '@condev-monitor/nextjs/client'

registerCondevClient({
    aiStreaming: {
        urlPatterns: ['/api/chat'],
        stallThresholdMs: 3000,
    },
    replay: true,
    user: { id: 'dev-tester', email: 'dev@test.com' },
})
