import { Inject } from '@nestjs/common'
import { REQUEST } from '@nestjs/core'

export class AppService {
    constructor(
        @Inject(REQUEST)
        private request: Request
    ) {}
    getDBPort(): number {
        const headers = this.request.headers
        const tenantId = headers['x-tenant-id']
        if (tenantId === 'mysql1') {
            return 3307
        }
        return 3306
    }
}
