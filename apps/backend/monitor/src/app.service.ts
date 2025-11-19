// import { Inject } from '@nestjs/common'
// import { REQUEST } from '@nestjs/core'

import { Inject, OnApplicationShutdown } from '@nestjs/common'
import { DataSource } from 'typeorm'

// export class AppService {
//     constructor(
//         @Inject(REQUEST)
//         private request: Request
//     ) {}
//     getDBConfig(): any {
//         const headers = this.request.headers
//         const tenantId = headers['x-tenant-id']
//         if (tenantId === 'mysql1') {
//             return {
//                 port: 3307,
//             }
//         } else if (tenantId === 'postgresql') {
//             return {
//                 type: 'postgres',
//                 port: 5432,
//                 username: 'pguser',
//                 database: 'testdb',
//             }
//         }
//         return {
//             port: 3306,
//         }
//     }
// }

export class AppService implements OnApplicationShutdown {
    constructor(@Inject('TYPEORM_CONNECTIONS') private connections: Map<string, DataSource>) {}
    onApplicationShutdown() {
        if (this.connections.size > 0) {
            for (const key of this.connections.keys()) {
                this.connections.get(key)?.destroy()
            }
        }
    }
}
