/**
 * Format a Date as a ClickHouse DateTime64(3) string using UTC methods.
 *
 * ClickHouse columns are declared with 'Asia/Shanghai' timezone,
 * but the engine handles the conversion itself — the input must be UTC.
 * Using getUTC*() avoids dependence on container-local timezone.
 */
export function formatDateTimeForCH(date: Date): string {
    const pad = (n: number, w = 2) => String(n).padStart(w, '0')
    return (
        `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
        `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)}`
    )
}
