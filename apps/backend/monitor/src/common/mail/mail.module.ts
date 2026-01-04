import { Module } from '@nestjs/common'
import { createTransport } from 'nodemailer'

import { MailService } from './mail.service'

@Module({
    providers: [
        {
            provide: 'MAIL_MODE',
            useFactory: () => {
                const mailOn = process.env.MAIL_ON === 'true'
                const emailSender = process.env.EMAIL_SENDER
                const emailSenderPassword = process.env.EMAIL_SENDER_PASSWORD

                if (!mailOn) return 'off'
                if (!emailSender || !emailSenderPassword) return 'json'
                return 'smtp'
            },
        },
        {
            provide: 'EMAIL_CLIENT',
            useFactory: () => {
                const mailOn = process.env.MAIL_ON === 'true'
                const emailSender = process.env.EMAIL_SENDER
                const emailSenderPassword = process.env.EMAIL_SENDER_PASSWORD
                const smtpHost = process.env.SMTP_HOST ?? 'smtp.163.com'
                const smtpPort = Number(process.env.SMTP_PORT ?? 465)
                const smtpSecure = (process.env.SMTP_SECURE ?? 'true') === 'true'

                if (!mailOn || !emailSender || !emailSenderPassword) {
                    return createTransport({ jsonTransport: true })
                }

                return createTransport({
                    host: smtpHost,
                    port: smtpPort,
                    secure: smtpSecure,
                    auth: {
                        user: emailSender,
                        pass: emailSenderPassword,
                    },
                })
            },
        },
        MailService,
    ],
    exports: [MailService, 'MAIL_MODE'],
})
export class MailModule {}
