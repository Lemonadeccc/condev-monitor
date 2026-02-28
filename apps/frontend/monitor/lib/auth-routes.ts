export const PUBLIC_AUTH_PATHS = ['/login', '/register', '/forgot-password', '/reset-password', '/confirm-email', '/verify-email'] as const

const PUBLIC_AUTH_PATH_SET = new Set<string>(PUBLIC_AUTH_PATHS)

export function isPublicAuthPath(pathname: string) {
    return PUBLIC_AUTH_PATH_SET.has(pathname)
}
