import { Injectable, NotFoundException } from '@nestjs/common'
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

    async update(payload: { id: number; type?: string; name?: string; description?: string }) {
        const application = await this.applicationRepository.findOne({
            where: { id: payload.id },
        })

        if (!application) {
            throw new Error('Application not found')
        }

        if (payload.type !== undefined) application.type = payload.type as any
        if (payload.name !== undefined) application.name = payload.name
        if (payload.description !== undefined) application.description = payload.description

        application.updatedAt = new Date()

        await this.applicationRepository.save(application)
        return application
    }

    async list(params: { userId: number }) {
        const [data, count] = await this.applicationRepository.findAndCount({
            where: { user: { id: params.userId } },
        })

        return {
            applications: data,
            count,
        }
    }

    async delete(payload: { appId: string; userId: number }) {
        const res = await this.applicationRepository.delete({ appId: payload.appId, user: { id: payload.userId } })

        if (res.affected === 0) {
            return new NotFoundException('Application not found')
        }

        return res.raw[0]
    }
}
