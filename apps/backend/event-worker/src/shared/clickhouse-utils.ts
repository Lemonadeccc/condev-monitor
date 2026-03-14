type ConfigLike = { get<T = string>(key: string): T | undefined }

export function resolveClickhouseDatabase(config: ConfigLike): string {
    return (config.get<string>('CLICKHOUSE_DATABASE') ?? 'lemonade').trim() || 'lemonade'
}
