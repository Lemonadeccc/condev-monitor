type ConfigLike = { get<T = string>(key: string): T | undefined }

export function resolveClickhouseDatabase(config: ConfigLike): string {
    const canonical = config.get<string>('CLICKHOUSE_DATABASE')?.trim()
    const legacy = config.get<string>('CLICKHOUSE_DB')?.trim()
    const resolved = canonical || legacy || 'lemonade'

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(resolved)) {
        throw new Error('Invalid ClickHouse database name. Use only ASCII letters, digits, and underscores, and do not start with a digit.')
    }

    return resolved
}
