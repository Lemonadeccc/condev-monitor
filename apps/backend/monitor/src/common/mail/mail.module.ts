import { Module } from '@nestjs/common'
import { createTransport } from 'nodemailer'

import { MailService } from './mail.service'

@Module({
    providers: [
        {
            provide: 'EMAIL_CLIENT',
            useFactory: () =>
                createTransport({
                    host: 'smtp.163.com',
                    port: 465,
                    secure: true,
                    auth: {
                        user: process.env.EMAIL_SENDER,
                        pass: process.env.EMAIL_SENDER_PASSWORD,
                    },
                }),
        },
        MailService,
    ],
    exports: [MailService],
})
export class MailModule {}
