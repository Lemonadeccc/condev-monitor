import * as fs from 'node:fs'
import { join } from 'node:path'

import { Inject, Injectable, Logger } from '@nestjs/common'
import { compile } from 'handlebars'

import type { EmailClient } from '../../fundamentals/email/email-client'

@Injectable()
export class EmailService {
    private readonly defaultFrom: string

    constructor(@Inject('EMAIL_CLIENT') private readonly emailClient: EmailClient) {
        this.defaultFrom = process.env.RESEND_FROM ?? `"condev-monitor" <${process.env.EMAIL_SENDER ?? 'no-reply@condev.local'}>`
    }

    async alert(params: { to: string; subject: string; params: any }) {
        const alterTemplate = await fs.promises.readFile(join(__dirname, '../../templates/email/issues.hbs'), 'utf-8')
        const res = await this.emailClient.sendMail({
            from: this.defaultFrom,
            to: params.to,
            subject: params.subject,
            html: compile(alterTemplate)(params.params),
        })

        Logger.log('Email sent', res)
    }
}
