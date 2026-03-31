export function parseDateTimeValue(value: Date | string | number) {
    if (value instanceof Date) return value

    if (typeof value === 'string') {
        const trimmed = value.trim()
        const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/)

        if (match) {
            const [, year, month, day, hour, minute, second, millisecond = '0'] = match
            return new Date(
                Date.UTC(
                    Number(year),
                    Number(month) - 1,
                    Number(day),
                    Number(hour),
                    Number(minute),
                    Number(second),
                    Number(millisecond.padEnd(3, '0'))
                )
            )
        }
    }

    return new Date(value)
}

export function formatDateTime(value: Date | string | number) {
    const date = parseDateTimeValue(value)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
        date.getSeconds()
    )}`
}

export function toDateTimeLocalValue(value: Date | string | number | null | undefined) {
    if (!value) return ''
    const date = parseDateTimeValue(value)
    if (Number.isNaN(date.getTime())) return ''

    const pad = (n: number) => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}
