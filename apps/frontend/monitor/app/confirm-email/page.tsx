'use client'

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'

export default function ConfirmEmailPage() {
    const router = useRouter()
    const searchParams = useSearchParams()
    const token = useMemo(() => searchParams.get('token') || '', [searchParams])

    const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle')
    const [message, setMessage] = useState('Confirming your email...')

    useEffect(() => {
        const run = async () => {
            try {
                if (!token) throw new Error('Missing token')
                const res = await fetch('/api/auth/change-email/confirm', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token }),
                })

                if (!res.ok) {
                    const body = (await res.json()) as { message?: string }
                    throw new Error(body.message || 'Confirm failed')
                }

                const result = (await res.json()) as { success: boolean }
                if (!result.success) throw new Error('Confirm failed')

                setStatus('success')
                setMessage('Email updated successfully.')
                localStorage.removeItem('access_token')
                localStorage.removeItem('refresh_token')
                setTimeout(() => router.push('/login'), 1000)
            } catch (err: unknown) {
                setStatus('error')
                setMessage((err as Error).message || 'Confirm failed')
            }
        }

        void run()
    }, [token, router])

    return (
        <div className="relative h-screen w-full bg-black">
            <div className="absolute left-8 top-8 text-2xl font-bold text-white">CONDEV-MONITOR</div>
            <div className="flex h-screen w-full items-center justify-center">
                <Card className="w-full max-w-md">
                    <CardHeader>
                        <CardTitle className="text-2xl font-bold">Confirm email</CardTitle>
                        <CardDescription>Finish updating your email address</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div
                            className={
                                status === 'error'
                                    ? 'rounded bg-red-100 p-2 text-red-600 dark:bg-red-900/30 dark:text-red-400'
                                    : status === 'success'
                                      ? 'rounded bg-green-100 p-2 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                                      : 'rounded bg-gray-100 p-2 text-gray-700 dark:bg-gray-900/30 dark:text-gray-200'
                            }
                        >
                            {message}
                        </div>
                    </CardContent>
                    <CardFooter className="flex justify-center">
                        <Button asChild variant="outline">
                            <Link href="/profile">Back to profile</Link>
                        </Button>
                    </CardFooter>
                </Card>
            </div>
        </div>
    )
}
