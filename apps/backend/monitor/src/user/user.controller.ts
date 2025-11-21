import { Controller, Get } from '@nestjs/common'

import { UserRepository } from './user.repository'

@Controller('user')
export class UserController {
    constructor(private userRepository: UserRepository) {}
    @Get()
    async getHello(): Promise<any> {
        const res = await this.userRepository.find()
        return res
    }
}
