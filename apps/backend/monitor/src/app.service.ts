import { Inject } from '@nestjs/common'
import { REQUEST } from '@nestjs/core'

export class AppService {
    constructor(
        @Inject(REQUEST)
        private request: Request
    ) {}
    getDBConfig(): any {
        const headers = this.request.headers
        const tenantId = headers['x-tenant-id']
        if (tenantId === 'mysql1') {
            return {
                port: 3307,
            }
        } else if (tenantId === 'postgresql') {
            return {
                type: 'postgresql',
                port: 5432,
                username: 'pguser',
                database: 'testdb',
            }
        }
        return {
            port: 3306,
        }
    }
}
