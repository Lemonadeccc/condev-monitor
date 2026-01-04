import { Module } from '@nestjs/common'
import { createTransport } from 'nodemailer'

import { NodemailerEmailClient, ResendEmailClient } from './email-client'
import { MailService } from './mail.service'

export type MailMode = 'off' | 'json' | 'smtp' | 'resend'

@Module({
    providers: [
        {
            provide: 'MAIL_MODE',
            useFactory: () => {
                const mailOn = process.env.MAIL_ON === 'true'
                const emailSender = process.env.EMAIL_SENDER
                const emailSenderPassword = process.env.EMAIL_SENDER_PASSWORD
                const resendApiKey = process.env.RESEND_API_KEY

                if (!mailOn) return 'off' as const
                if (resendApiKey) return 'resend' as const
                if (emailSender && emailSenderPassword) return 'smtp' as const
                return 'json' as const
            },
        },
        {
            provide: 'EMAIL_CLIENT',
            useFactory: () => {
                const mailOn = process.env.MAIL_ON === 'true'
                const emailSender = process.env.EMAIL_SENDER
                const emailSenderPassword = process.env.EMAIL_SENDER_PASSWORD
                const resendApiKey = process.env.RESEND_API_KEY
                const smtpHost = process.env.SMTP_HOST ?? 'smtp.163.com'
                const smtpPort = Number(process.env.SMTP_PORT ?? 465)
                const smtpSecure = (process.env.SMTP_SECURE ?? 'true') === 'true'
                const connectionTimeout = Number(process.env.SMTP_CONNECTION_TIMEOUT_MS ?? 5000)
                const greetingTimeout = Number(process.env.SMTP_GREETING_TIMEOUT_MS ?? 5000)
                const socketTimeout = Number(process.env.SMTP_SOCKET_TIMEOUT_MS ?? 10000)

                if (!mailOn) {
                    return new NodemailerEmailClient(createTransport({ jsonTransport: true }))
                }

                if (resendApiKey) {
                    return new ResendEmailClient(resendApiKey)
                }

                if (!emailSender || !emailSenderPassword) {
                    return new NodemailerEmailClient(createTransport({ jsonTransport: true }))
                }

                return new NodemailerEmailClient(
                    createTransport({
                        host: smtpHost,
                        port: smtpPort,
                        secure: smtpSecure,
                        connectionTimeout,
                        greetingTimeout,
                        socketTimeout,
                        auth: {
                            user: emailSender,
                            pass: emailSenderPassword,
                        },
                    })
                )
            },
        },
        MailService,
    ],
    exports: [MailService, 'MAIL_MODE'],
})
export class MailModule {}
