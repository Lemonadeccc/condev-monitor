import { Inject } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { REQUEST } from '@nestjs/core'
import { TypeOrmModuleOptions, TypeOrmOptionsFactory } from '@nestjs/typeorm'

export class TypeormConfigService implements TypeOrmOptionsFactory {
    constructor(
        @Inject(REQUEST)
        private request: Request,
        private configService: ConfigService
    ) {}
    createTypeOrmOptions(): Promise<TypeOrmModuleOptions> | TypeOrmModuleOptions {
        const headers = this.request.headers
        const tenantId = headers['x-tenant-id']
        let config: any = {
            port: 3306,
        }
        const evnConfig = {
            type: this.configService.get('DB_TYPE'),
            host: this.configService.get('DB_HOST'),
            port: this.configService.get('DB_PORT'),
            username: this.configService.get('DB_USERNAME'),
            password: this.configService.get('DB_PASSWORD'),
            database: this.configService.get('DB_DATABASE'),
            autoLoadEntities: Boolean(this.configService.get('DB_AUTOLOAD')) || false,
            synchronize: Boolean(this.configService.get('DB_SYNC')) || false,
            // 额外的参数
            tenantId,
        }
        if (tenantId === 'typeorm2') {
            config = {
                port: 3307,
            }
        } else if (tenantId === 'typeorm3') {
            config = {
                type: 'postgres',
                port: 5432,
                username: 'pguser',
                database: 'testdb',
            }
        }
        const finalConfig = Object.assign(evnConfig, config) as TypeOrmModuleOptions
        return finalConfig
    }
}
