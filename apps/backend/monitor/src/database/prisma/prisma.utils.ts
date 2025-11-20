export const PROTOCALREGX = /^(.*?):\/\//

export function getDBType(url: string) {
    const matches = url.match(PROTOCALREGX)
    const protocol = matches ? matches[1] : 'file'
    return protocol === 'file' ? 'sqlite' : protocol
}
