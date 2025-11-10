import { getTransport } from './baseClient'

export function captureException(exception: Error) {
    getTransport()?.send({ event_type: 'custom', type: 'customError', exception })
}

export function captureMessage(message: string) {
    getTransport()?.send({ event_type: 'custom', type: 'customMessage', message })
}

/**
 * 自定义事件
 * @param event
 * @param data
 */
interface EventData<T> {
    eventType: string
    data: T
}
export function captureEvent<T>(eventData: EventData<T>) {
    getTransport()?.send({ event_type: 'custom', type: 'customEvent', eventData })
}
