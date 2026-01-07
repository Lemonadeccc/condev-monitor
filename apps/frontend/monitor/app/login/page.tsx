'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import Link from 'next/link'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'

import Beams from '@/components/Beams'
import { useAuth } from '@/components/providers'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

const loginSchema = z.object({
    email: z.string().min(1, 'Email is required').email('Invalid email format'),
    password: z.string().min(1, 'Password is required').max(50, 'Password is too long'),
})

type LoginFormValues = z.infer<typeof loginSchema>

export default function LoginPage() {
    const { login } = useAuth()
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(false)

    const form = useForm<LoginFormValues>({
        resolver: zodResolver(loginSchema),
        defaultValues: {
            email: '',
            password: '',
        },
    })

    const onSubmit = async (data: LoginFormValues) => {
        setError('')
        setLoading(true)

        try {
            await login(data)
        } catch (err: unknown) {
            setError((err as Error).message || 'Login failed')
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
                        <CardTitle className="text-2xl font-bold">Login</CardTitle>
                        <CardDescription>Enter your credentials to access your account</CardDescription>
                    </CardHeader>
                    <CardContent>
                        {error && (
                            <div className="mb-4 rounded bg-red-100 p-2 text-red-600 dark:bg-red-900/30 dark:text-red-400">{error}</div>
                        )}
                        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                            <Field>
                                <FieldLabel>Email</FieldLabel>
                                <Input type="email" placeholder="Enter your email" {...form.register('email')} />
                                <FieldError errors={[form.formState.errors.email]} />
                            </Field>
                            <Field>
                                <FieldLabel>Password</FieldLabel>
                                <Input type="password" placeholder="Enter your password" {...form.register('password')} />
                                <FieldError errors={[form.formState.errors.password]} />
                            </Field>
                            <Button type="submit" className="w-full" disabled={loading}>
                                {loading ? 'Logging in...' : 'Login'}
                            </Button>
                        </form>
                    </CardContent>
                    <CardFooter className="flex justify-center">
                        <div className="flex w-full justify-between text-sm text-gray-500 dark:text-gray-400">
                            <Link href="/forgot-password" className="font-medium text-blue-600 hover:underline dark:text-blue-400">
                                Forgot password?
                            </Link>
                            <span>
                                Don&apos;t have an account?{' '}
                                <Link href="/register" className="font-medium text-blue-600 hover:underline dark:text-blue-400">
                                    Register
                                </Link>
                            </span>
                        </div>
                    </CardFooter>
                </Card>
            </div>
        </div>
    )
}
