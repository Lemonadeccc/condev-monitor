import { Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'

import { ApplicationEntity } from './entity/application.entity'

@Injectable()
export class ApplicationService {
    constructor(
        @InjectRepository(ApplicationEntity)
        private readonly applicationRepository: Repository<ApplicationEntity>
    ) {}

    async create(application: ApplicationEntity) {
        await this.applicationRepository.save(application)
        return application
    }

    async list() {
        const params = { id: 1 } //cookie获取用户id
        const [data, count] = await this.applicationRepository.findAndCount({
            where: {
                user: {
                    id: params.id,
                },
            },
        })
        return {
            application: data,
            count,
        }
    }
}
