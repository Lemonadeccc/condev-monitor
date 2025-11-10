import { Integration, Monitoring } from '@condev-monitor/monitor-sdk-core'

import { BrowserTransport } from './transport'
import { Errors } from './tracing/errorsIntegration'
import { Metrics } from '@condev-monitor/monitor-sdk-browser-utils'

export const init = (options: { dsn: string; integrations?: Integration[] }) => {
    const monitoring = new Monitoring({
        dsn: options.dsn,
        integrations: options?.integrations,
    })

    const transport = new BrowserTransport(options.dsn)
    console.log('transport', transport)
    monitoring.init(transport)

    new Errors(transport).init()
    new Metrics(transport).init()

    return monitoring
}
