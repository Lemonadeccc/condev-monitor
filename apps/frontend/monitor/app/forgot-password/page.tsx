'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import Link from 'next/link'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'

import Beams from '@/components/Beams'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

const schema = z.object({
    email: z.string().min(1, 'Email is required').email('Invalid email format'),
})

type FormValues = z.infer<typeof schema>

export default function ForgotPasswordPage() {
    const [error, setError] = useState('')
    const [success, setSuccess] = useState('')
    const [loading, setLoading] = useState(false)

    const form = useForm<FormValues>({
        resolver: zodResolver(schema),
        defaultValues: { email: '' },
    })

    const onSubmit = async (data: FormValues) => {
        setError('')
        setSuccess('')
        setLoading(true)
        try {
            const res = await fetch('/api/auth/forgot-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data),
            })

            if (!res.ok) {
                const body = (await res.json()) as { message?: string }
                throw new Error(body.message || 'Request failed')
            }

            setSuccess('If the email exists, a reset link has been sent.')
        } catch (err: unknown) {
            setError((err as Error).message || 'Request failed')
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className="relative min-h-screen w-full overflow-hidden bg-black">
            <div className="pointer-events-none absolute inset-0 z-0" aria-hidden="true">
                <Beams
                    beamWidth={2}
                    beamHeight={15}
                    beamNumber={12}
                    lightColor="#ffffff"
                    speed={2}
                    noiseIntensity={1.75}
                    scale={0.2}
                    rotation={-30}
                />
            </div>
            <div className="absolute left-8 top-8 z-10 text-2xl font-bold text-white">CONDEV-MONITOR</div>
            <div className="relative z-10 flex min-h-screen w-full items-center justify-center">
                <Card className="w-full max-w-md">
                    <CardHeader>
                        <CardTitle className="text-2xl font-bold">Forgot password</CardTitle>
                        <CardDescription>Enter your email to receive a reset link</CardDescription>
                    </CardHeader>
                    <CardContent>
                        {error && (
                            <div className="mb-4 rounded bg-red-100 p-2 text-red-600 dark:bg-red-900/30 dark:text-red-400">{error}</div>
                        )}
                        {success && (
                            <div className="mb-4 rounded bg-green-100 p-2 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                                {success}
                            </div>
                        )}
                        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                            <Field>
                                <FieldLabel>Email</FieldLabel>
                                <Input type="email" placeholder="Enter your email" {...form.register('email')} />
                                <FieldError errors={[form.formState.errors.email]} />
                            </Field>
                            <Button type="submit" className="w-full" disabled={loading}>
                                {loading ? 'Sending...' : 'Send reset link'}
                            </Button>
                        </form>
                    </CardContent>
                    <CardFooter className="flex justify-center">
                        <Link href="/login" className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400">
                            Back to login
                        </Link>
                    </CardFooter>
                </Card>
            </div>
        </div>
    )
}
