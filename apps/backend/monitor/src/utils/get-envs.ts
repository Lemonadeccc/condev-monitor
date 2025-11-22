import * as dotenv from 'dotenv'

export function getEnvs() {
    const envFilePaths = [`.env.${process.env.NODE_ENV || `development`}`, '.env']
    const parsedConfig = dotenv.config({ path: '.env' }).parsed || {}
    envFilePaths.forEach(path => {
        if (path === '.env') return
        const config = dotenv.config({ path })
        if (config.parsed) {
            Object.assign(parsedConfig, config.parsed)
        }
    })
    return parsedConfig
}
