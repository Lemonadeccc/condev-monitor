import * as fs from 'node:fs'
import * as path from 'node:path'

import { Inject, Injectable } from '@nestjs/common'
import { compile } from 'handlebars'
import type { SendMailOptions, Transporter } from 'nodemailer'

export type MailSendOptions = Omit<SendMailOptions, 'from' | 'html'> & {
    from?: string
    template?: string
    context?: Record<string, any>
    html?: string
}

@Injectable()
export class MailService {
    private readonly templatesDir: string
    private readonly defaultFrom: string

    constructor(@Inject('EMAIL_CLIENT') private readonly emailClient: Transporter) {
        this.templatesDir = this.resolveTemplatesDir()
        this.defaultFrom = `"condev-monitor" <${process.env.EMAIL_SENDER}>`
    }

    async sendMail(options: MailSendOptions) {
        const { template, context, from, html, ...rest } = options

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
