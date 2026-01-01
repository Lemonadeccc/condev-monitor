'use client'

/* eslint-disable react-refresh/only-export-components */
import { usePathname, useRouter } from 'next/navigation'
import { createContext, useContext, useEffect, useState } from 'react'

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
    const router = useRouter()
    const pathname = usePathname()

    const isPublicPath = ['/login', '/register', '/forgot-password', '/reset-password', '/confirm-email', '/verify-email'].includes(
        pathname
    )

    useEffect(() => {
        checkAuth()
    }, [])

    useEffect(() => {
        if (!loading && !user && !isPublicPath) {
            router.push('/login')
        }
    }, [user, loading, isPublicPath, router])

    const checkAuth = async () => {
        try {
            const token = localStorage.getItem('access_token')
            if (!token) {
                setLoading(false)
                return
            }

            const res = await fetch('/api/me', {
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            })

            if (res.ok) {
                const userData = await res.json()
                setUser(userData as User)
            } else {
                localStorage.removeItem('access_token')
                setUser(null)
            }
        } catch (error) {
            // eslint-disable-next-line no-console
            console.error('Auth check failed', error)
            localStorage.removeItem('access_token')
            setUser(null)
        } finally {
            setLoading(false)
        }
    }

    const login = async (data: LoginData) => {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        })

        if (!res.ok) {
            const error = (await res.json()) as { message?: string }
            throw new Error(error.message || 'Login failed')
        }

        const result = (await res.json()) as { success: boolean; data: { access_token: string } }
        if (result.success && result.data.access_token) {
            localStorage.setItem('access_token', result.data.access_token)
            await checkAuth()
            router.push('/')
        }
    }

    const register = async (data: RegisterData) => {
        const res = await fetch('/api/admin/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        })

        if (!res.ok) {
            const error = (await res.json()) as { message?: string }
            throw new Error(error.message || 'Registration failed')
        }

        // Auto login after register or redirect to login
        router.push('/login')
    }

    const updateProfile = async (data: Partial<Pick<User, 'email' | 'phone' | 'role'>>) => {
        const token = localStorage.getItem('access_token')
        if (!token) throw new Error('Not authenticated')

        const res = await fetch('/api/admin/profile', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(data),
        })

        if (!res.ok) {
            const error = (await res.json()) as { message?: string }
            throw new Error(error.message || 'Update profile failed')
        }

        const result = (await res.json()) as { success: boolean; data: User }
        if (result.success) setUser(result.data)
    }

    const logout = async () => {
        try {
            // Optional: Call backend logout if needed
            // await fetch('/api/auth/logout', { method: 'POST' })
        } finally {
            localStorage.removeItem('access_token')
            localStorage.removeItem('refresh_token')
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
