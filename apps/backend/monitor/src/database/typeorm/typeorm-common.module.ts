import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { UserTypeormRepository } from 'src/user/repository/user.typeorm.repository'
// import { User } from 'src/user/user.entity'
import { DataSource } from 'typeorm'

import { TYPEORM_DATABASE } from '../database-constant'
import { TypeormProvider } from './typeorm.provider'
import { TypeormConfigService } from './typeorm-config.service'

const connections = new Map()

@Module({
    imports: [
        TypeOrmModule.forRootAsync({
            name: TYPEORM_DATABASE,
            useClass: TypeormConfigService,
            dataSourceFactory: async options => {
                // tenantId
                const tenantId = options!['tenantId'] || 'default'
                if (tenantId && connections.has(tenantId)) {
                    return connections.get(tenantId)
                }
                const dataSource = await new DataSource(options as any).initialize()
                connections.set(tenantId, dataSource)
                return dataSource
            },
        }),
    ],
    providers: [
        TypeormProvider,
        {
            provide: 'TYPEORM_CONNECTIONS',
            useValue: connections,
        },
    ],
    exports: [UserTypeormRepository],
})
export class TypeormCommonModule {}
