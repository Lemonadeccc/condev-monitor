import { DynamicModule, Global, Module } from '@nestjs/common'
import type { ModuleMetadata } from '@nestjs/common/interfaces'
import { createTransport } from 'nodemailer'

import { NodemailerEmailClient, ResendEmailClient } from './email-client'

export type EmailModuleOptions =
    | { provider: 'resend'; apiKey: string }
    | { provider: 'smtp'; host: string; port: number; secure: boolean; auth: { user: string; pass: string } }
    | { provider: 'json' }

@Global()
@Module({
    imports: [],
    controllers: [],
    providers: [],
})
export class EmailModule {
    static forRoot(options: EmailModuleOptions): DynamicModule {
        return {
            module: EmailModule,
            providers: [
                {
                    provide: 'EMAIL_CLIENT',
                    useFactory: () => {
                        if (options.provider === 'resend') {
                            return new ResendEmailClient(options.apiKey)
                        }

                        if (options.provider === 'json') {
                            return new NodemailerEmailClient(createTransport({ jsonTransport: true }))
                        }

                        // Strip the discriminant field before passing to nodemailer.
                        // eslint-disable-next-line @typescript-eslint/no-unused-vars
                        const { provider: _provider, ...smtpOptions } = options
                        return new NodemailerEmailClient(createTransport(smtpOptions))
                    },
                },
            ],
            exports: ['EMAIL_CLIENT'],
        }
    }

    static forRootAsync(
        options: Pick<ModuleMetadata, 'imports'> & { inject?: any[]; useFactory: (...args: any[]) => EmailModuleOptions }
    ): DynamicModule {
        return {
            module: EmailModule,
            imports: options.imports,
            providers: [
                {
                    provide: 'EMAIL_CLIENT',
                    inject: options.inject ?? [],
                    useFactory: (...args: any[]) => {
                        const resolvedOptions = options.useFactory(...args)

                        if (resolvedOptions.provider === 'resend') {
                            return new ResendEmailClient(resolvedOptions.apiKey)
                        }

                        if (resolvedOptions.provider === 'json') {
                            return new NodemailerEmailClient(createTransport({ jsonTransport: true }))
                        }

                        // Strip the discriminant field before passing to nodemailer.
                        // eslint-disable-next-line @typescript-eslint/no-unused-vars
                        const { provider: _provider, ...smtpOptions } = resolvedOptions
                        return new NodemailerEmailClient(createTransport(smtpOptions))
                    },
                },
            ],
            exports: ['EMAIL_CLIENT'],
        }
    }
}
