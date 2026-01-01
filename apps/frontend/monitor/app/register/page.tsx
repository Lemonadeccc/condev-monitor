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

const registerSchema = z
    .object({
        email: z.string().min(1, 'Email is required').email('Invalid email format'),
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

type RegisterFormValues = z.infer<typeof registerSchema>

export default function RegisterPage() {
    const { register } = useAuth()
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(false)

    const form = useForm<RegisterFormValues>({
        resolver: zodResolver(registerSchema),
        defaultValues: {
            email: '',
            password: '',
            confirmPassword: '',
        },
    })

    const onSubmit = async (data: RegisterFormValues) => {
        setError('')
        setLoading(true)

        try {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { confirmPassword, ...registerData } = data
            await register(registerData)
        } catch (err: unknown) {
            setError((err as Error).message || 'Registration failed')
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
                        <CardTitle className="text-2xl font-bold">Register</CardTitle>
                        <CardDescription>Create a new account to get started</CardDescription>
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
                            <Field>
                                <FieldLabel>Confirm Password</FieldLabel>
                                <Input type="password" placeholder="Confirm your password" {...form.register('confirmPassword')} />
                                <FieldError errors={[form.formState.errors.confirmPassword]} />
                            </Field>
                            <Button type="submit" className="w-full" disabled={loading}>
                                {loading ? 'Creating account...' : 'Register'}
                            </Button>
                        </form>
                    </CardContent>
                    <CardFooter className="flex justify-center">
                        <p className="text-sm text-gray-500 dark:text-gray-400">
                            Already have an account?{' '}
                            <Link href="/login" className="font-medium text-blue-600 hover:underline dark:text-blue-400">
                                Login
                            </Link>
                        </p>
                    </CardFooter>
                </Card>
            </div>
        </div>
    )
}
