import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

import { isPublicAuthPath } from '@/lib/auth-routes'
import { SESSION_COOKIE_NAME } from '@/lib/session-cookie'

export function middleware(request: NextRequest) {
    const { pathname } = request.nextUrl
    const sessionToken = request.cookies.get(SESSION_COOKIE_NAME)?.value
    const isPublicPath = isPublicAuthPath(pathname)

    if (!sessionToken && !isPublicPath) {
        const loginUrl = new URL('/login', request.url)
        loginUrl.searchParams.set('from', pathname)
        return NextResponse.redirect(loginUrl)
    }

    return NextResponse.next()
}

export const config = {
    matcher: ['/((?!api|auth-session|_next/static|_next/image|favicon.ico|.*\\..*).*)'],
}
