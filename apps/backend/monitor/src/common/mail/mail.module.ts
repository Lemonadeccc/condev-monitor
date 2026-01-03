import { Module } from '@nestjs/common'
import { createTransport } from 'nodemailer'

import { MailService } from './mail.service'

@Module({
    providers: [
        {
            provide: 'EMAIL_CLIENT',
            useFactory: () => {
                const mailOn = process.env.MAIL_ON === 'true'
                const emailSender = process.env.EMAIL_SENDER
                const emailSenderPassword = process.env.EMAIL_SENDER_PASSWORD

                if (!mailOn || !emailSender || !emailSenderPassword) {
                    return createTransport({ jsonTransport: true })
                }

                return createTransport({
                    host: 'smtp.163.com',
                    port: 465,
                    secure: true,
                    auth: {
                        user: emailSender,
                        pass: emailSenderPassword,
                    },
                })
            },
        },
        MailService,
    ],
    exports: [MailService],
})
export class MailModule {}
