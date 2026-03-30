export function formatDateTimeForCH(date: Date): string {
    const pad = (n: number, w = 2) => String(n).padStart(w, '0')
    return (
        `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
        `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)}`
    )
}

export function parseDateTimeForCH(value: string | Date | null | undefined): string | null {
    if (!value) return null
    const date = value instanceof Date ? value : new Date(value)
    if (Number.isNaN(date.getTime())) return null
    return formatDateTimeForCH(date)
}
