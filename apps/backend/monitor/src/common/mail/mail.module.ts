import * as fs from 'node:fs'
import * as path from 'node:path'

import { Module } from '@nestjs/common'
import { MailerModule } from '@nestjs-modules/mailer'
import { HandlebarsAdapter } from '@nestjs-modules/mailer/dist/adapters/handlebars.adapter'

@Module({
    imports: [
        // https://nest-modules.github.io/mailer/docs/mailer
        MailerModule.forRootAsync({
            useFactory: () => ({
                transport: {
                    host: 'smtp.163.com',
                    port: 465,
                    secure: true,
                    auth: {
                        user: process.env.EMAIL_SENDER,
                        pass: process.env.EMAIL_SENDER_PASSWORD,
                    },
                },
                defaults: {
                    from: `"condev-monitor" <${process.env.EMAIL_SENDER}>`,
                },
                template: {
                    dir: (() => {
                        const candidates = [
                            // Prefer source templates in dev (avoids stale dist assets)
                            path.resolve(process.cwd(), 'src/common/mail/templates'),
                            path.resolve(process.cwd(), 'apps/backend/monitor/src/common/mail/templates'),

                            path.resolve(process.cwd(), 'dist/common/mail/templates'),
                            path.resolve(process.cwd(), 'apps/backend/monitor/dist/common/mail/templates'),
                            path.resolve(process.cwd(), 'common/mail/templates'),

                            path.resolve(__dirname, '../../../../common/mail/templates'),

                            path.resolve(__dirname, 'templates'),
                        ]

                        return candidates.find(candidate => fs.existsSync(candidate)) ?? path.resolve(__dirname, 'templates')
                    })(),
                    adapter: new HandlebarsAdapter(),
                    options: {
                        strict: true,
                    },
                },
            }),
        }),
    ],
    exports: [MailerModule],
})
export class MailModule {}
