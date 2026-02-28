import { NextResponse } from 'next/server'

import { SESSION_COOKIE_MAX_AGE_SECONDS, SESSION_COOKIE_NAME } from '@/lib/session-cookie'

type LoginResponse = {
    success?: boolean
    message?: string
    data?: {
        access_token?: string
    }
}

function getMonitorApiBaseUrl() {
    return process.env.API_PROXY_TARGET ?? 'http://localhost:8081'
}

export async function POST(req: Request) {
    let payload: { email?: string; password?: string }
    let backendRes: Response

    try {
        payload = (await req.json()) as { email?: string; password?: string }
    } catch {
        return NextResponse.json({ message: 'Invalid request body' }, { status: 400 })
    }

    try {
        backendRes = await fetch(`${getMonitorApiBaseUrl()}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            cache: 'no-store',
        })
    } catch {
        return NextResponse.json({ message: 'Auth service is unavailable' }, { status: 502 })
    }

    const body = (await backendRes.json().catch(() => ({}))) as LoginResponse
    if (!backendRes.ok) {
        return NextResponse.json(body, { status: backendRes.status })
    }

    const token = body.data?.access_token
    if (!token) {
        return NextResponse.json({ message: 'Invalid login response from auth server' }, { status: 502 })
    }

    const response = NextResponse.json({ success: true }, { status: backendRes.status })
    response.cookies.set(SESSION_COOKIE_NAME, token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
    })
    return response
}
