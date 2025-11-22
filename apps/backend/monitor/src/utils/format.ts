export function toBoolean(value: any): boolean {
    if (value === 'true' || value === true) {
        return true
    }
    return false
}
