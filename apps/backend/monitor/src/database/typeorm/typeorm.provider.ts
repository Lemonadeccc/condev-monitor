import { Inject, OnApplicationShutdown } from '@nestjs/common'
import { DataSource } from 'typeorm'

export class TypeormProvider implements OnApplicationShutdown {
    constructor(@Inject('TYPEORM_CONNECTIONS') private connections: Map<string, DataSource>) {}
    onApplicationShutdown() {
        if (this.connections.size > 0) {
            for (const key of this.connections.keys()) {
                this.connections.get(key)?.destroy()
            }
        }
    }
}
