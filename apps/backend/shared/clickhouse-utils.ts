/** Minimal interface matching ConfigService.get() — avoids importing @nestjs/config in shared code. */
type ConfigLike = { get<T = string>(key: string): T | undefined }

/**
 * Resolves the ClickHouse database name from config, with a safe fallback to 'lemonade'.
 * Centralized here to avoid three independent copies of the same trim/fallback logic.
 */
export function resolveClickhouseDatabase(config: ConfigLike): string {
    return (config.get<string>('CLICKHOUSE_DATABASE') ?? 'lemonade').trim() || 'lemonade'
}
