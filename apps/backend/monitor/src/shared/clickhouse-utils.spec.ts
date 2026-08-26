import { resolveClickhouseDatabase } from './clickhouse-utils'

function config(values: Record<string, string | undefined>) {
    return { get: <T = string>(key: string) => values[key] as T | undefined }
}

describe('resolveClickhouseDatabase', () => {
    it('prefers the canonical name and trims it', () => {
        expect(resolveClickhouseDatabase(config({ CLICKHOUSE_DATABASE: ' custom_monitor ', CLICKHOUSE_DB: 'legacy_monitor' }))).toBe(
            'custom_monitor'
        )
    })

    it('keeps the legacy alias and default compatible', () => {
        expect(resolveClickhouseDatabase(config({ CLICKHOUSE_DB: 'legacy_monitor' }))).toBe('legacy_monitor')
        expect(resolveClickhouseDatabase(config({ CLICKHOUSE_DATABASE: ' ', CLICKHOUSE_DB: 'legacy_monitor' }))).toBe('legacy_monitor')
        expect(resolveClickhouseDatabase(config({ CLICKHOUSE_DATABASE: ' ' }))).toBe('lemonade')
        expect(resolveClickhouseDatabase(config({}))).toBe('lemonade')
    })

    it.each(['9monitor', 'monitor-prod', 'monitor.db', 'monitor` UNION SELECT 1', '监控'])('rejects unsafe identifier %s', database => {
        expect(() => resolveClickhouseDatabase(config({ CLICKHOUSE_DATABASE: database }))).toThrow('Invalid ClickHouse database name')
    })
})
