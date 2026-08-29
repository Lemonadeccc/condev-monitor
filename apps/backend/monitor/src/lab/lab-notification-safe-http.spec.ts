import { SafeLabNotificationHttpClient } from './lab-notification-safe-http'

describe('SafeLabNotificationHttpClient', () => {
    const client = new SafeLabNotificationHttpClient()

    it.each([
        'http://hooks.example.test/notify',
        'https://user:password@hooks.example.test/notify',
        'https://hooks.example.test/notify?token=secret',
        'https://hooks.example.test/notify#fragment',
        'https://127.0.0.1/notify',
        'https://10.0.0.1/notify',
        'https://192.168.1.1/notify',
        'https://[::1]/notify',
        'https://[fc00::1]/notify',
        'https://[2001:db8::1]/notify',
        'https://[64:ff9b::a00:1]/notify',
        'https://[64:ff9b:1::a00:1]/notify',
        'https://[2001::1]/notify',
        'https://[2002:a00:1::]/notify',
    ])('rejects an unsafe endpoint before attempting a request: %s', async endpoint => {
        await expect(client.post(endpoint, '{}', {})).rejects.toThrow()
    })

    it('rejects a body larger than the closed notification payload boundary', async () => {
        await expect(client.post('https://hooks.example.test/notify', 'x'.repeat(16 * 1024 + 1), {})).rejects.toThrow(
            'Lab notification request body is too large'
        )
    })
})
