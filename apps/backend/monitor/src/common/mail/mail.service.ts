import * as fs from 'node:fs'
import * as path from 'node:path'

import { Inject, Injectable } from '@nestjs/common'
import { compile } from 'handlebars'

import type { EmailSendParams } from './email-client'
import type { EmailClient } from './email-client'
import type { MailMode } from './mail.module'

export type MailSendOptions = EmailSendParams & {
    template?: string
    context?: Record<string, any>
}

@Injectable()
export class MailService {
    private readonly templatesDir: string
    private readonly defaultFrom: string

    constructor(
        @Inject('EMAIL_CLIENT') private readonly emailClient: EmailClient,
        @Inject('MAIL_MODE') private readonly mailMode: MailMode
    ) {
        this.templatesDir = this.resolveTemplatesDir()
        this.defaultFrom = process.env.RESEND_FROM ?? `"condev-monitor" <${process.env.EMAIL_SENDER ?? 'no-reply@condev.local'}>`
    }

    async sendMail(options: MailSendOptions) {
        const { template, context, from, html, ...rest } = options

        if (this.mailMode === 'json') {
            // eslint-disable-next-line no-console
            console.warn(
                'MAIL_ON is true but no email provider is configured (RESEND_API_KEY or SMTP credentials); email will not be delivered.',
                {
                    to: rest.to,
                    subject: rest.subject,
                }
            )
        }

        const resolvedHtml =
            html ??
            (template
                ? compile(await fs.promises.readFile(path.join(this.templatesDir, `${template}.hbs`), 'utf-8'), {
                      strict: true,
                  })(context ?? {})
                : undefined)

        return this.emailClient.sendMail({
            ...rest,
            from: from ?? this.defaultFrom,
            html: resolvedHtml,
        })
    }

    private resolveTemplatesDir() {
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
    }
}
