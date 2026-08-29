import { Module } from '@nestjs/common'
import { createTransport } from 'nodemailer'

import type { EmailClient } from './email-client'
import { NodemailerEmailClient, ResendEmailClient } from './email-client'
import { MailService } from './mail.service'

export type MailMode = 'off' | 'json' | 'smtp' | 'resend'
type MailEnvironment = Record<string, string | undefined>

export function resolveMailMode(environment: MailEnvironment = process.env): MailMode {
    if (environment.MAIL_ON !== 'true') return 'off'
    if (environment.RESEND_API_KEY && environment.RESEND_FROM) return 'resend'
    if (environment.EMAIL_SENDER && environment.EMAIL_SENDER_PASSWORD) return 'smtp'
    return 'json'
}

export function createPlatformEmailClient(environment: MailEnvironment = process.env): EmailClient {
    const mode = resolveMailMode(environment)
    if (mode === 'resend') {
        return new ResendEmailClient(environment.RESEND_API_KEY!)
    }

    if (mode !== 'smtp') {
        return new NodemailerEmailClient(createTransport({ jsonTransport: true }))
    }

    return new NodemailerEmailClient(
        createTransport({
            host: environment.SMTP_HOST ?? 'smtp.163.com',
            port: Number(environment.SMTP_PORT ?? 465),
            secure: (environment.SMTP_SECURE ?? 'true') === 'true',
            connectionTimeout: Number(environment.SMTP_CONNECTION_TIMEOUT_MS ?? 5000),
            greetingTimeout: Number(environment.SMTP_GREETING_TIMEOUT_MS ?? 5000),
            socketTimeout: Number(environment.SMTP_SOCKET_TIMEOUT_MS ?? 10000),
            auth: {
                user: environment.EMAIL_SENDER!,
                pass: environment.EMAIL_SENDER_PASSWORD!,
            },
        })
    )
}

@Module({
    providers: [
        {
            provide: 'MAIL_MODE',
            useFactory: () => resolveMailMode(),
        },
        {
            provide: 'EMAIL_CLIENT',
            useFactory: () => createPlatformEmailClient(),
        },
        MailService,
    ],
    exports: [MailService, 'MAIL_MODE'],
})
export class MailModule {}
