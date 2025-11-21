import { InjectRepository } from '@nestjs/typeorm'
import { TYPEORM_DATABASE } from 'src/database/database-constant'
import { Repository } from 'typeorm'

import { User } from '../user.entity'
import { UserAdapter } from '../user.interface'

export class UserTypeormRepository implements UserAdapter {
    constructor(@InjectRepository(User, TYPEORM_DATABASE) private userRepository: Repository<User>) {}
    find(): Promise<any[]> {
        return this.userRepository.find({})
    }
    create(userObj: any): Promise<any> {
        return this.userRepository.save(userObj)
    }
    update(userObj: any): Promise<any> {
        return this.userRepository.update(userObj.id, userObj)
    }
    delete(userObj: any): Promise<any> {
        return this.userRepository.delete(userObj.id)
    }
}
