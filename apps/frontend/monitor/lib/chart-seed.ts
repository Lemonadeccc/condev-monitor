export function createStableChartData(seed: string): Array<{ date: string; value: number }> {
    const seedNum = hashStringToUint32(seed)
    const rand = mulberry32(seedNum)
    return new Array(7).fill(0).map((_, index) => {
        const date = new Date()
        date.setDate(date.getDate() - (6 - index))
        return {
            date: date.toISOString(),
            value: Math.floor(rand() * (100 - 20) + 20),
        }
    })
}

function hashStringToUint32(input: string): number {
    let hash = 2166136261
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i)
        hash = Math.imul(hash, 16777619)
    }
    return hash >>> 0
}

function mulberry32(a: number) {
    return function () {
        let t = (a += 0x6d2b79f5)
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}
