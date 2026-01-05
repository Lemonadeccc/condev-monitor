import { Integration, Monitoring } from '@condev-monitor/monitor-sdk-core'

import { BrowserTransport } from './transport'
import { Errors } from './tracing/errorsIntegration'
import { WhiteScreen, WhiteScreenOptions } from './tracing/whiteScreenIntegration'
import { Metrics } from '@condev-monitor/monitor-sdk-browser-utils'

let whiteScreen: WhiteScreen | null = null

export type { WhiteScreenOptions }

export const triggerWhiteScreenCheck = (reason?: string) => {
    whiteScreen?.trigger(reason)
}

export const init = (options: { dsn: string; integrations?: Integration[]; whiteScreen?: boolean | WhiteScreenOptions }) => {
    const monitoring = new Monitoring({
        dsn: options.dsn,
        integrations: options?.integrations,
    })

    const transport = new BrowserTransport(options.dsn)
    monitoring.init(transport)

    new Errors(transport).init()
    new Metrics(transport).init()

    if (options.whiteScreen !== false) {
        const whiteScreenOptions = typeof options.whiteScreen === 'object' ? options.whiteScreen : undefined
        whiteScreen = new WhiteScreen(transport, whiteScreenOptions)
        whiteScreen.init()
    }

    return monitoring
}
