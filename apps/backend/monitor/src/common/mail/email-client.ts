import type { Transporter } from 'nodemailer'

export type EmailAddress = string
export type EmailAddressOrList = EmailAddress | EmailAddress[]

export type EmailSendParams = {
    to: EmailAddressOrList
    subject: string
    from?: string
    html?: string
    text?: string
    cc?: EmailAddressOrList
    bcc?: EmailAddressOrList
    replyTo?: EmailAddressOrList
    idempotencyKey?: string
    timeoutMs?: number
    signal?: AbortSignal
}

export interface EmailClient {
    sendMail(params: EmailSendParams): Promise<unknown>
}

export class NodemailerEmailClient implements EmailClient {
    constructor(private readonly transporter: Transporter) {}

    sendMail(params: EmailSendParams) {
        const { idempotencyKey, timeoutMs, signal, ...message } = params
        void timeoutMs
        if (signal?.aborted) return Promise.reject(new Error('Email delivery was cancelled before SMTP submission'))
        return this.transporter.sendMail({
            ...message,
            ...(idempotencyKey
                ? {
                      messageId: `<${idempotencyKey}@condev-monitor.local>`,
                      headers: { 'Resend-Idempotency-Key': idempotencyKey },
                  }
                : {}),
        } as any)
    }
}

export class ResendEmailClient implements EmailClient {
    constructor(
        private readonly apiKey: string,
        private readonly endpoint = 'https://api.resend.com/emails'
    ) {}

    async sendMail(params: EmailSendParams) {
        const { idempotencyKey, timeoutMs, signal: callerSignal, ...message } = params
        const to = Array.isArray(message.to) ? message.to : message.to ? [message.to] : []
        const cc = Array.isArray(message.cc) ? message.cc : message.cc ? [message.cc] : undefined
        const bcc = Array.isArray(message.bcc) ? message.bcc : message.bcc ? [message.bcc] : undefined

        const timeoutSignal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined
        const signal = callerSignal && timeoutSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : (callerSignal ?? timeoutSignal)
        const res = await fetch(this.endpoint, {
            method: 'POST',
            ...(signal ? { signal } : {}),
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
                ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
            },
            body: JSON.stringify({
                from: message.from,
                to,
                subject: message.subject,
                html: message.html,
                text: message.text,
                cc,
                bcc,
                reply_to: message.replyTo,
            }),
        })

        if (!res.ok) {
            const body = await res.text().catch(() => '')
            throw new Error(`Resend sendMail failed: ${res.status} ${res.statusText}${body ? ` - ${body}` : ''}`)
        }

        return res.json().catch(() => ({}))
    }
}
