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
}

export interface EmailClient {
    sendMail(params: EmailSendParams): Promise<unknown>
}

export class NodemailerEmailClient implements EmailClient {
    constructor(private readonly transporter: Transporter) {}

    sendMail(params: EmailSendParams) {
        return this.transporter.sendMail(params as any)
    }
}

export class ResendEmailClient implements EmailClient {
    constructor(
        private readonly apiKey: string,
        private readonly endpoint = 'https://api.resend.com/emails'
    ) {}

    async sendMail(params: EmailSendParams) {
        const to = Array.isArray(params.to) ? params.to : params.to ? [params.to] : []
        const cc = Array.isArray(params.cc) ? params.cc : params.cc ? [params.cc] : undefined
        const bcc = Array.isArray(params.bcc) ? params.bcc : params.bcc ? [params.bcc] : undefined

        const res = await fetch(this.endpoint, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from: params.from,
                to,
                subject: params.subject,
                html: params.html,
                text: params.text,
                cc,
                bcc,
                reply_to: params.replyTo,
            }),
        })

        if (!res.ok) {
            const body = await res.text().catch(() => '')
            throw new Error(`Resend sendMail failed: ${res.status} ${res.statusText}${body ? ` - ${body}` : ''}`)
        }

        return res.json().catch(() => ({}))
    }
}
