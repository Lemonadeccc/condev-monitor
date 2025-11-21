import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'

import { UserAdapter } from '../user.interface'
import { User } from '../user.schema'

export class UserMongooseRepository implements UserAdapter {
    constructor(@InjectModel('User') private userModel: Model<User>) {}
    async find(): Promise<any[]> {
        return this.userModel.find()
    }
    async create(userObj: any): Promise<any> {
        return this.userModel.create(userObj)
    }
    async update(userObj: any): Promise<any> {
        return this.userModel.updateOne(userObj)
    }
    async delete(userObj: any): Promise<any> {
        return this.userModel.deleteOne({ _id: userObj.id })
    }
}
