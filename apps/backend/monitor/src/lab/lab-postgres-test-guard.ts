export const ANIMATION_LAB_POSTGRES_WRITE_SENTINEL = 'condev-animation-lab-postgres-integration'
export const REMOTE_POSTGRES_OPT_IN = 'TEST_POSTGRES_ALLOW_REMOTE'

type PostgresWriteGuardOptions = Readonly<{
    suiteName: string
    url: string | undefined
    writeSentinel: string | undefined
    allowRemote: string | undefined
}>

export function assertAnimationLabPostgresWriteAccess(options: PostgresWriteGuardOptions): string {
    const { suiteName, url, writeSentinel, allowRemote } = options
    if (!url) throw new Error(`TEST_POSTGRES_URL is required for ${suiteName}`)
    if (writeSentinel !== ANIMATION_LAB_POSTGRES_WRITE_SENTINEL) {
        throw new Error(`TEST_POSTGRES_WRITE_SENTINEL must equal ${ANIMATION_LAB_POSTGRES_WRITE_SENTINEL}`)
    }

    let parsed: URL
    try {
        parsed = new URL(url)
    } catch {
        throw new Error(`TEST_POSTGRES_URL must be a valid PostgreSQL URL for ${suiteName}`)
    }
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
        throw new Error(`TEST_POSTGRES_URL must use postgres:// or postgresql:// for ${suiteName}`)
    }
    if (!isLoopbackHostname(parsed.hostname) && allowRemote !== '1') {
        throw new Error(
            `Refusing non-loopback TEST_POSTGRES_URL host "${parsed.hostname}" for ${suiteName}; ` +
                `set ${REMOTE_POSTGRES_OPT_IN}=1 only for an isolated remote test database`
        )
    }
    return url
}

function isLoopbackHostname(hostname: string): boolean {
    const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (normalized === 'localhost' || normalized === '::1') return true
    const ipv4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
    if (!ipv4) return false
    const octets = ipv4.slice(1).map(Number)
    return octets.every(octet => octet >= 0 && octet <= 255) && octets[0] === 127
}
