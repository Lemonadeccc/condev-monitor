'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import Link from 'next/link'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'

import { useAuth } from '@/components/providers'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

const loginSchema = z.object({
    username: z.string().min(1, 'Username is required'),
    password: z.string().min(1, 'Password is required'),
})

type LoginFormValues = z.infer<typeof loginSchema>

export default function LoginPage() {
    const { login } = useAuth()
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(false)

    const form = useForm<LoginFormValues>({
        resolver: zodResolver(loginSchema),
        defaultValues: {
            username: '',
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
        <div className="relative h-screen w-full bg-black">
            <div className="absolute left-8 top-8 text-2xl font-bold text-white">CONDEV-MONITOR</div>
            <div className="flex h-screen w-full items-center justify-center">
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
                                <FieldLabel>Username</FieldLabel>
                                <Input placeholder="Enter your username" {...form.register('username')} />
                                <FieldError errors={[form.formState.errors.username]} />
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
                        <p className="text-sm text-gray-500 dark:text-gray-400">
                            Don&apos;t have an account?{' '}
                            <Link href="/register" className="font-medium text-blue-600 hover:underline dark:text-blue-400">
                                Register
                            </Link>
                        </p>
                    </CardFooter>
                </Card>
            </div>
        </div>
    )
}
