import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { HydratedDocument } from 'mongoose'

export type UserDocument = HydratedDocument<User>

@Schema()
export class User {
    @Prop()
    username: string

    @Prop()
    password: number
}

export const UserSchema = SchemaFactory.createForClass(User)

// export const UserSchema = new mongoose.Schema(
//     {
//         username: String,
//         password: String,
//     },
//     {
//         collection: 'users',
//     }
// )
