// import { Inject } from '@nestjs/common'
// import { REQUEST } from '@nestjs/core'
// import { InjectRepository } from '@nestjs/typeorm'
// import { Request } from 'express'
// import { User } from 'src/user/user.entity'
// import { Repository } from 'typeorm'

// export class UserRepository {
//     constructor(
//         @InjectRepository(User)
//         private userRepository: Repository<User>,

//         @InjectRepository(User, 'mysql1')
//         private userRepository1: Repository<User>,

//         @Inject(REQUEST)
//         private request: Request
//     ) {}

//     getRepository(): any {
//         // const { query } = this.request
//         // const { db } = query
//         // if (db === 'mysql1') {
//         //     return this.userRepository1
//         // }
//         // return this.userRepository

//         const headers = this.request.headers
//         const tenantId = headers['x-tenant-id']
//         if (tenantId === 'mysql1') {
//             return this.userRepository1
//         }
//         return this.userRepository
//     }
// }
