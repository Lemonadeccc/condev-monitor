import { resolveClickhouseDatabase } from './clickhouse-utils'

function config(values: Record<string, string | undefined>) {
    return { get: <T = string>(key: string) => values[key] as T | undefined }
}

describe('resolveClickhouseDatabase', () => {
    it('supports the canonical key, legacy alias, and default', () => {
        expect(resolveClickhouseDatabase(config({ CLICKHOUSE_DATABASE: 'animation_prod' }))).toBe('animation_prod')
        expect(resolveClickhouseDatabase(config({ CLICKHOUSE_DB: 'legacy_monitor' }))).toBe('legacy_monitor')
        expect(resolveClickhouseDatabase(config({}))).toBe('lemonade')
    })

    it('rejects identifiers that could alter a generated query', () => {
        expect(() => resolveClickhouseDatabase(config({ CLICKHOUSE_DATABASE: 'lemonade; DROP DATABASE default' }))).toThrow(
            'Invalid ClickHouse database name'
        )
    })
})
