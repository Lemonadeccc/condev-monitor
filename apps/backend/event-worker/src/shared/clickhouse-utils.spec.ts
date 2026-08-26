import { resolveClickhouseDatabase } from './clickhouse-utils'

function config(values: Record<string, string | undefined>) {
    return { get: <T = string>(key: string) => values[key] as T | undefined }
}

describe('resolveClickhouseDatabase', () => {
    it('supports the canonical key, legacy alias, and default', () => {
        expect(resolveClickhouseDatabase(config({ CLICKHOUSE_DATABASE: 'worker_prod' }))).toBe('worker_prod')
        expect(resolveClickhouseDatabase(config({ CLICKHOUSE_DB: 'legacy_monitor' }))).toBe('legacy_monitor')
        expect(resolveClickhouseDatabase(config({}))).toBe('lemonade')
    })

    it('rejects identifiers that could alter insert table names', () => {
        expect(() => resolveClickhouseDatabase(config({ CLICKHOUSE_DATABASE: '../default' }))).toThrow('Invalid ClickHouse database name')
    })
})
