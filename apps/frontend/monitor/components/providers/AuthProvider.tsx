'use client'

import { usePathname, useRouter } from 'next/navigation'
import { createContext, useContext, useEffect, useState } from 'react'

interface User {
    id: number
    username: string
    role?: string
    [key: string]: unknown
}

interface LoginData {
    username: string
    password: string
}

interface RegisterData {
    username: string
    password: string
    email?: string
    [key: string]: unknown
}

interface AuthContextType {
    user: User | null
    loading: boolean
    login: (data: LoginData) => Promise<void>
    register: (data: RegisterData) => Promise<void>
    logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function AuthProvider({ children }: { children: React.ReactNode }) {
    const [user, setUser] = useState<User | null>(null)
    const [loading, setLoading] = useState(true)
    const router = useRouter()
    const pathname = usePathname()

    const isPublicPath = ['/login', '/register'].includes(pathname)

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

    const logout = async () => {
        try {
            // Optional: Call backend logout if needed
            // await fetch('/api/auth/logout', { method: 'POST' })
        } finally {
            localStorage.removeItem('access_token')
            setUser(null)
            router.push('/login')
        }
    }

    return <AuthContext.Provider value={{ user, loading, login, register, logout }}>{children}</AuthContext.Provider>
}

export function useAuth() {
    const context = useContext(AuthContext)
    if (context === undefined) {
        throw new Error('useAuth must be used within an AuthProvider')
    }
    return context
}
