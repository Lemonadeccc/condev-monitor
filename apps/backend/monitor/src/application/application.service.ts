import { HttpException, HttpStatus, Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'

import { ApplicationEntity } from './entity/application.entity'

@Injectable()
export class ApplicationService {
    constructor(
        @InjectRepository(ApplicationEntity)
        private readonly applicationRepository: Repository<ApplicationEntity>
    ) {}

    private normalizeName(name: string | undefined) {
        return (name ?? '').trim()
    }

    async create(application: ApplicationEntity) {
        application.name = this.normalizeName(application.name)

        const existing = await this.applicationRepository.findOne({
            where: { name: application.name, user: { id: application.user.id }, isDelete: false },
        })
        if (existing) {
            throw new HttpException({ message: 'Application name already exists', error: 'NAME_EXISTS' }, HttpStatus.CONFLICT)
        }

        await this.applicationRepository.save(application)
        return application
    }

    async update(payload: { id: number; userId: number; type?: string; name?: string; description?: string }) {
        const application = await this.applicationRepository.findOne({
            where: { id: payload.id, user: { id: payload.userId }, isDelete: false },
        })

        if (!application) {
            throw new HttpException({ message: 'Application not found', error: 'NOT_FOUND' }, HttpStatus.NOT_FOUND)
        }

        if (payload.type !== undefined) application.type = payload.type as any
        if (payload.name !== undefined) {
            const nextName = this.normalizeName(payload.name)
            if (nextName !== application.name) {
                const existing = await this.applicationRepository.findOne({
                    where: { name: nextName, user: { id: payload.userId }, isDelete: false },
                })
                if (existing && existing.id !== application.id) {
                    throw new HttpException({ message: 'Application name already exists', error: 'NAME_EXISTS' }, HttpStatus.CONFLICT)
                }
            }
            application.name = nextName
        }
        if (payload.description !== undefined) application.description = payload.description

        application.updatedAt = new Date()

        await this.applicationRepository.save(application)
        return application
    }

    async list(params: { userId: number }) {
        const [data, count] = await this.applicationRepository.findAndCount({
            where: { user: { id: params.userId }, isDelete: false },
        })

        return {
            applications: data,
            count,
        }
    }

    async getOne(params: { id: number; userId: number }) {
        const application = await this.applicationRepository.findOne({
            where: {
                id: params.id,
                user: { id: params.userId },
                isDelete: false,
            },
        })

        return application
    }

    async delete(payload: { appId: string; userId: number }) {
        const application = await this.applicationRepository.findOne({
            where: {
                appId: payload.appId,
                user: { id: payload.userId },
                isDelete: false,
            },
        })

        if (!application) {
            throw new Error('Application not found')
        }

        await this.applicationRepository.update(application.id, {
            isDelete: true,
            updatedAt: new Date(),
        })

        return { success: true }
    }
}
