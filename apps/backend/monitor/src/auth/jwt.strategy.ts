import { Injectable, UnauthorizedException } from '@nestjs/common'
import { PassportStrategy } from '@nestjs/passport'
import { ExtractJwt, Strategy } from 'passport-jwt'

import { AdminService } from '../admin/admin.service'
import { jwtConstants } from './constants'

function extractCookieToken(rawCookieHeader: string | undefined, cookieName: string) {
    if (!rawCookieHeader) return null
    const entries = rawCookieHeader.split(';')
    for (const entry of entries) {
        const [name, ...parts] = entry.trim().split('=')
        if (name === cookieName) {
            return decodeURIComponent(parts.join('='))
        }
    }
    return null
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
    constructor(private readonly adminService: AdminService) {
        super({
            jwtFromRequest: ExtractJwt.fromExtractors([
                (req: { headers?: { cookie?: string } } | undefined) =>
                    extractCookieToken(req?.headers?.cookie, jwtConstants.sessionCookieName),
                ExtractJwt.fromAuthHeaderAsBearerToken(),
            ]),
            ignoreExpiration: false,
            secretOrKey: jwtConstants.secret,
        })
    }

    async validate(payload: any) {
        if (payload?.tokenType !== 'access') {
            throw new UnauthorizedException('Invalid token')
        }
        const user = await this.adminService.findOneById(payload.sub)
        return user
    }
}
