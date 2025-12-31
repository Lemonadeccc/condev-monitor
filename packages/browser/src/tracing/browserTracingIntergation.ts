import { captureConsoleIntegration, captureMessage } from '@condev-monitor/monitor-sdk-core'

export const browserTracingIntegration = () => {
    captureMessage('browserTracingIntegration')
    return {
        name: 'browserTracingIntegration',
        setupOnce() {
            captureConsoleIntegration()
        },
    }
}
