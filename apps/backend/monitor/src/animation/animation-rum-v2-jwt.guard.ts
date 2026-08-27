import { ExecutionContext, Injectable } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'

@Injectable()
export class AnimationRumV2JwtGuard extends AuthGuard('jwt') {
    override canActivate(context: ExecutionContext) {
        const response = context.switchToHttp().getResponse()
        response.setHeader('Cache-Control', 'private, no-store')
        response.setHeader('Pragma', 'no-cache')
        return super.canActivate(context)
    }
}
