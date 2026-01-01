'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

const passwordSchema = z
    .object({
        password: z
            .string()
            .min(6, 'Password must be between 6 and 50 characters')
            .max(50, 'Password must be between 6 and 50 characters')
            .regex(
                /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[^]{6,}$/,
                'Password must contain at least one uppercase letter, one lowercase letter and one number'
            ),
        confirmPassword: z.string(),
    })
    .refine(data => data.password === data.confirmPassword, {
        message: "Passwords don't match",
        path: ['confirmPassword'],
    })

type FormValues = z.infer<typeof passwordSchema>

export default function ResetPasswordPage() {
    const router = useRouter()
    const searchParams = useSearchParams()
    const token = useMemo(() => searchParams.get('token') || '', [searchParams])

    const [error, setError] = useState('')
    const [loading, setLoading] = useState(false)
    const [email, setEmail] = useState<string>('')
    const [verifying, setVerifying] = useState(true)

    const form = useForm<FormValues>({
        resolver: zodResolver(passwordSchema),
        defaultValues: { password: '', confirmPassword: '' },
    })

    useEffect(() => {
        const run = async () => {
            try {
                if (!token) throw new Error('Missing token')
                const res = await fetch('/api/auth/reset-password/verify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token }),
                })

                if (!res.ok) {
                    const body = (await res.json()) as { message?: string }
                    throw new Error(body.message || 'Invalid token')
                }

                const result = (await res.json()) as { success: boolean; email?: string }
                if (!result.success || !result.email) throw new Error('Invalid token')
                setEmail(result.email)
            } catch (err: unknown) {
                setError((err as Error).message || 'Invalid token')
            } finally {
                setVerifying(false)
            }
        }
        void run()
    }, [token])

    const onSubmit = async (data: FormValues) => {
        setError('')
        setLoading(true)
        try {
            if (!token) throw new Error('Missing token')

            const res = await fetch('/api/auth/reset-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token, password: data.password }),
            })

            if (!res.ok) {
                const body = (await res.json()) as { message?: string }
                throw new Error(body.message || 'Reset failed')
            }

            const result = (await res.json()) as { success: boolean }
            if (!result.success) throw new Error('Reset failed')

            router.push('/login')
        } catch (err: unknown) {
            setError((err as Error).message || 'Reset failed')
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className="relative h-screen w-full bg-black">
            <div className="absolute left-8 top-8 text-2xl font-bold text-white">CONDEV-MONITOR</div>
            <div className="flex h-screen w-full items-center justify-center">
                <Card className="w-full max-w-md">
                    <CardHeader>
                        <CardTitle className="text-2xl font-bold">Reset password</CardTitle>
                        <CardDescription>
                            {verifying
                                ? 'Verifying reset link...'
                                : email
                                  ? `Reset password for: ${email}`
                                  : 'Set a new password for your account'}
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        {error && (
                            <div className="mb-4 rounded bg-red-100 p-2 text-red-600 dark:bg-red-900/30 dark:text-red-400">{error}</div>
                        )}
                        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                            <Field>
                                <FieldLabel>New password</FieldLabel>
                                <Input type="password" placeholder="Enter a new password" {...form.register('password')} />
                                <FieldError errors={[form.formState.errors.password]} />
                            </Field>
                            <Field>
                                <FieldLabel>Confirm password</FieldLabel>
                                <Input type="password" placeholder="Confirm new password" {...form.register('confirmPassword')} />
                                <FieldError errors={[form.formState.errors.confirmPassword]} />
                            </Field>
                            <Button type="submit" className="w-full" disabled={loading || verifying || !email}>
                                {loading ? 'Saving...' : 'Reset password'}
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
