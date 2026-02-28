'use client'

/* eslint-disable react-refresh/only-export-components */
import { usePathname, useRouter } from 'next/navigation'
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

import { isPublicAuthPath } from '@/lib/auth-routes'

interface User {
    id: number
    email: string
    phone?: string
    role?: string
    [key: string]: unknown
}

interface LoginData {
    email: string
    password: string
}

interface RegisterData {
    email: string
    password: string
    [key: string]: unknown
}

interface AuthContextType {
    user: User | null
    loading: boolean
    login: (data: LoginData) => Promise<void>
    register: (data: RegisterData) => Promise<void>
    updateProfile: (data: Partial<Pick<User, 'email' | 'phone' | 'role'>>) => Promise<void>
    logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function AuthProvider({ children }: { children: React.ReactNode }) {
    const [user, setUser] = useState<User | null>(null)
    const [loading, setLoading] = useState(true)
    const userRef = useRef<User | null>(null)
    const router = useRouter()
    const pathname = usePathname()

    const isPublicPath = isPublicAuthPath(pathname)

    const checkAuth = useCallback(
        async (options?: { force?: boolean }) => {
            const force = options?.force ?? false
            if (isPublicPath && !force) {
                setLoading(false)
                return
            }
            if (!force && userRef.current) {
                setLoading(false)
                return
            }

            try {
                const res = await fetch('/api/me', {
                    cache: 'no-store',
                })

                if (res.ok) {
                    const userData = await res.json()
                    userRef.current = userData as User
                    setUser(userData as User)
                } else {
                    if (res.status === 401 || res.status === 403) {
                        void fetch('/auth-session/logout', { method: 'POST' }).catch(() => undefined)
                    }
                    userRef.current = null
                    setUser(null)
                }
            } catch (error) {
                // eslint-disable-next-line no-console
                console.error('Auth check failed', error)
                userRef.current = null
                setUser(null)
            } finally {
                setLoading(false)
            }
        },
        [isPublicPath]
    )

    useEffect(() => {
        void checkAuth()
    }, [checkAuth])

    useEffect(() => {
        userRef.current = user
    }, [user])

    useEffect(() => {
        if (!loading && !user && !isPublicPath) {
            router.push('/login')
        }
    }, [user, loading, isPublicPath, router])

    const login = async (data: LoginData) => {
        const res = await fetch('/auth-session/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        })

        if (!res.ok) {
            const error = (await res.json().catch(() => ({}))) as { message?: string }
            throw new Error(error.message || 'Login failed')
        }

        setLoading(true)
        await checkAuth({ force: true })
        router.push('/')
    }

    const register = async (data: RegisterData) => {
        const res = await fetch('/api/admin/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        })

        if (!res.ok) {
            const error = (await res.json().catch(() => ({}))) as { message?: string }
            throw new Error(error.message || 'Registration failed')
        }

        // Auto login after register or redirect to login
        router.push('/login')
    }

    const updateProfile = async (data: Partial<Pick<User, 'email' | 'phone' | 'role'>>) => {
        const res = await fetch('/api/admin/profile', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data),
        })

        if (!res.ok) {
            const error = (await res.json().catch(() => ({}))) as { message?: string }
            throw new Error(error.message || 'Update profile failed')
        }

        const result = (await res.json()) as { success: boolean; data: User }
        if (result.success) setUser(result.data)
    }

    const logout = async () => {
        try {
            await fetch('/auth-session/logout', { method: 'POST' })
        } finally {
            setUser(null)
            router.push('/login')
        }
    }

    return <AuthContext.Provider value={{ user, loading, login, register, updateProfile, logout }}>{children}</AuthContext.Provider>
}

export function useAuth() {
    const context = useContext(AuthContext)
    if (context === undefined) {
        throw new Error('useAuth must be used within an AuthProvider')
    }
    return context
}
