import { NodemailerEmailClient, ResendEmailClient } from './email-client'
import { createPlatformEmailClient, resolveMailMode } from './mail.module'

describe('MailModule provider selection', () => {
    it('prefers Resend when production mail has both Resend and SMTP credentials', () => {
        const environment = {
            MAIL_ON: 'true',
            RESEND_API_KEY: 'resend-key',
            RESEND_FROM: 'alerts@example.test',
            EMAIL_SENDER: 'smtp-user',
            EMAIL_SENDER_PASSWORD: 'smtp-password',
        }

        expect(resolveMailMode(environment)).toBe('resend')
        expect(createPlatformEmailClient(environment)).toBeInstanceOf(ResendEmailClient)
    })

    it('uses SMTP only when Resend is unavailable and explicit SMTP credentials exist', () => {
        const environment = {
            MAIL_ON: 'true',
            EMAIL_SENDER: 'smtp-user',
            EMAIL_SENDER_PASSWORD: 'smtp-password',
        }

        expect(resolveMailMode(environment)).toBe('smtp')
        expect(createPlatformEmailClient(environment)).toBeInstanceOf(NodemailerEmailClient)
    })

    it('does not select Resend without an explicit verified sender', () => {
        const environment = {
            MAIL_ON: 'true',
            RESEND_API_KEY: 'resend-key',
            EMAIL_SENDER: 'smtp-user',
            EMAIL_SENDER_PASSWORD: 'smtp-password',
        }

        expect(resolveMailMode(environment)).toBe('smtp')
        expect(createPlatformEmailClient(environment)).toBeInstanceOf(NodemailerEmailClient)
    })

    it('keeps delivery suppressed when mail is disabled or no real provider is configured', () => {
        expect(resolveMailMode({ MAIL_ON: 'false' })).toBe('off')
        expect(resolveMailMode({ MAIL_ON: 'true' })).toBe('json')
        expect(createPlatformEmailClient({ MAIL_ON: 'true' })).toBeInstanceOf(NodemailerEmailClient)
    })
})
