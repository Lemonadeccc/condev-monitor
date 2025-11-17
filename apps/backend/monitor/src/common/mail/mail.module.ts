import { Module } from '@nestjs/common'
import { MailerModule } from '@nestjs-modules/mailer'
import { HandlebarsAdapter } from '@nestjs-modules/mailer/dist/adapters/handlebars.adapter'

@Module({
    imports: [
        // https://nest-modules.github.io/mailer/docs/mailer
        MailerModule.forRootAsync({
            useFactory: () => ({
                transport: `smtps://${process.env.EMAIL_SENDER}:${process.env.EMAIL_SENDER_PASSWORD}@smtp.qq.com`,
                defaults: {
                    from: '"condev-monitor" <627636361@qq.com>',
                },
                template: {
                    dir: __dirname + '/templates',
                    adapter: new HandlebarsAdapter(),
                    options: {
                        strict: true,
                    },
                },
            }),
        }),
    ],
})
export class MailModule {}
