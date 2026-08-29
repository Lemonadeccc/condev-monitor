import { NodemailerEmailClient, ResendEmailClient } from './email-client'

describe('EmailClient delivery controls', () => {
    it('keeps ordinary Nodemailer behavior unchanged and adds stable Lab idempotency only when requested', async () => {
        const transporter = { sendMail: jest.fn().mockResolvedValue({ accepted: ['owner@example.test'] }) }
        const client = new NodemailerEmailClient(transporter as never)

        await client.sendMail({ to: 'owner@example.test', subject: 'ordinary' })
        await client.sendMail({
            to: 'owner@example.test',
            subject: 'lab',
            idempotencyKey: '55555555-5555-4555-8555-555555555555',
            timeoutMs: 20_000,
        })

        expect(transporter.sendMail.mock.calls[0]?.[0]).not.toHaveProperty('messageId')
        expect(transporter.sendMail.mock.calls[1]?.[0]).toEqual(
            expect.objectContaining({
                messageId: '<55555555-5555-4555-8555-555555555555@condev-monitor.local>',
                headers: { 'Resend-Idempotency-Key': '55555555-5555-4555-8555-555555555555' },
            })
        )
        expect(transporter.sendMail.mock.calls[1]?.[0]).not.toHaveProperty('timeoutMs')
        expect(transporter.sendMail.mock.calls[1]?.[0]).not.toHaveProperty('idempotencyKey')
    })

    it('does not submit an SMTP message when the caller already lost delivery ownership', async () => {
        const transporter = { sendMail: jest.fn() }
        const client = new NodemailerEmailClient(transporter as never)
        const controller = new AbortController()
        controller.abort()

        await expect(client.sendMail({ to: 'owner@example.test', subject: 'lab', signal: controller.signal })).rejects.toThrow(
            'cancelled before SMTP submission'
        )
        expect(transporter.sendMail).not.toHaveBeenCalled()
    })

    it('applies a per-call Resend deadline and HTTP idempotency key without adding them to the body', async () => {
        const response = { ok: true, json: jest.fn().mockResolvedValue({ id: 'email-1' }) }
        const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(response as never)
        const client = new ResendEmailClient('test-api-key')

        await client.sendMail({
            from: 'Condev <no-reply@example.test>',
            to: 'owner@example.test',
            subject: 'lab',
            text: 'bounded body',
            idempotencyKey: '55555555-5555-4555-8555-555555555555',
            timeoutMs: 20_000,
        })

        const [, init] = fetchSpy.mock.calls[0]
        expect(init?.headers).toEqual(expect.objectContaining({ 'Idempotency-Key': '55555555-5555-4555-8555-555555555555' }))
        expect(init?.signal).toBeInstanceOf(AbortSignal)
        expect(init?.body).not.toContain('idempotencyKey')
        expect(init?.body).not.toContain('timeoutMs')
        fetchSpy.mockRestore()
    })

    it('forwards caller cancellation to Resend in addition to its absolute deadline', async () => {
        const response = { ok: true, json: jest.fn().mockResolvedValue({ id: 'email-1' }) }
        const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(response as never)
        const client = new ResendEmailClient('test-api-key')
        const controller = new AbortController()

        await client.sendMail({
            to: 'owner@example.test',
            subject: 'lab',
            signal: controller.signal,
            timeoutMs: 20_000,
        })

        const signal = fetchSpy.mock.calls[0]?.[1]?.signal
        expect(signal).toBeInstanceOf(AbortSignal)
        controller.abort()
        expect(signal?.aborted).toBe(true)
        fetchSpy.mockRestore()
    })
})
