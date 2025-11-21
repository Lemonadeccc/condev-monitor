import { Injectable } from '@nestjs/common'

@Injectable()
export class AuthService {
    signin(username: string, password: string) {
        return 'signin' + username + '*' + password
    }

    signup(username: string, password: string) {
        return 'signup' + username + '*' + password
    }
}
