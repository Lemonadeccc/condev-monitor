'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'

import { useAuth } from '@/components/providers'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

const profileSchema = z.object({
    email: z.string().min(1, 'Email is required').email('Invalid email format'),
})

type ProfileFormValues = z.infer<typeof profileSchema>

export default function ProfilePage() {
    const { user } = useAuth()
    const [error, setError] = useState('')
    const [success, setSuccess] = useState('')
    const [loading, setLoading] = useState(false)

    const currentEmail = user?.email || ''

    const form = useForm<ProfileFormValues>({
        resolver: zodResolver(profileSchema),
        defaultValues: {
            email: '',
        },
    })

    const inputEmail = form.watch('email')
    const canSubmit = useMemo(() => {
        const nextEmail = (inputEmail || '').trim()
        if (!nextEmail) return false
        if (!currentEmail) return false
        return nextEmail !== currentEmail
    }, [inputEmail, currentEmail])

    const onSubmit = async (data: ProfileFormValues) => {
        setError('')
        setSuccess('')
        setLoading(true)
        try {
            if (data.email.trim() === currentEmail) {
                throw new Error('New email must be different from current email')
            }
            const token = localStorage.getItem('access_token')
            if (!token) throw new Error('Not authenticated')

            const res = await fetch('/api/auth/change-email/request', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ email: data.email }),
            })

            if (!res.ok) {
                const body = (await res.json()) as { message?: string }
                throw new Error(body.message || 'Request failed')
            }

            setSuccess('A confirmation link has been sent to your new email.')
        } catch (err: unknown) {
            setError((err as Error).message || 'Update failed')
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className="mx-auto max-w-2xl p-4">
            <Card>
                <CardHeader>
                    <CardTitle>Profile</CardTitle>
                    <CardDescription>Current email: {currentEmail || '-'}</CardDescription>
                </CardHeader>
                <CardContent>
                    <h3 className="mb-4 text-lg font-medium">Change Email Address</h3>
                    {error && <div className="mb-4 rounded bg-red-100 p-2 text-red-600 dark:bg-red-900/30 dark:text-red-400">{error}</div>}
                    {success && (
                        <div className="mb-4 rounded bg-green-100 p-2 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                            {success}
                        </div>
                    )}

                    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                        <Field>
                            <FieldLabel>New email</FieldLabel>
                            <Input type="email" placeholder="Enter your email" {...form.register('email')} />
                            <FieldError errors={[form.formState.errors.email]} />
                        </Field>
                        <Button type="submit" disabled={loading || !canSubmit}>
                            {loading ? 'Saving...' : 'Save'}
                        </Button>
                    </form>
                </CardContent>
            </Card>
        </div>
    )
}
