import {
    Body,
    Controller,
    Delete,
    Get,
    Param,
    Post,
    Query,
    Request,
    UnauthorizedException,
    UploadedFile,
    UseGuards,
    UseInterceptors,
} from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { AuthGuard } from '@nestjs/passport'
import { FileInterceptor } from '@nestjs/platform-express'

import { CreateSourcemapTokenDto } from './dto/create-sourcemap-token.dto'
import { UploadSourcemapDto } from './dto/upload-sourcemap.dto'
import { SourcemapService } from './sourcemap.service'
import { SourcemapTokenService } from './sourcemap-token.service'

@Controller('/sourcemap')
export class SourcemapController {
    constructor(
        private readonly sourcemapService: SourcemapService,
        private readonly sourcemapTokenService: SourcemapTokenService,
        private readonly jwtService: JwtService
    ) {}

    private parseBearerToken(authHeader?: string): string | null {
        if (!authHeader) return null
        const [type, token] = authHeader.split(' ')
        if (type !== 'Bearer' || !token) return null
        return token
    }

    private async resolveUserIdFromAuthHeader(authHeader?: string): Promise<number | null> {
        const token = this.parseBearerToken(authHeader)
        if (!token) return null
        try {
            const payload = this.jwtService.verify(token) as { sub?: number; tokenType?: string }
            if (!payload?.sub) return null
            if (payload.tokenType && payload.tokenType !== 'access') return null
            return payload.sub
        } catch {
            return null
        }
    }

    @Post('/upload')
    @UseInterceptors(FileInterceptor('file'))
    async upload(@Body() body: UploadSourcemapDto, @UploadedFile() file: Express.Multer.File | undefined, @Request() req) {
        const authHeader = req.headers?.authorization as string | undefined
        const userId = await this.resolveUserIdFromAuthHeader(authHeader)
        const tokenHeader =
            (req.headers?.['x-sourcemap-token'] as string | undefined) ?? (req.headers?.['x-api-token'] as string | undefined)

        if (!userId && !tokenHeader) {
            throw new UnauthorizedException('Missing auth token')
        }

        if (tokenHeader) {
            await this.sourcemapTokenService.verifyToken({ token: tokenHeader, appId: body.appId })
        }

        const data = await this.sourcemapService.upload({
            userId: userId ?? undefined,
            appId: body.appId,
            release: body.release,
            dist: body.dist,
            minifiedUrl: body.minifiedUrl,
            file,
        })
        return { success: true, data }
    }

    @Get()
    @UseGuards(AuthGuard('jwt'))
    async list(@Query('appId') appId: string, @Request() req) {
        const data = await this.sourcemapService.list({ appId, userId: req.user.id })
        return { success: true, data }
    }

    @Get('/token')
    @UseGuards(AuthGuard('jwt'))
    async listTokens(@Query('appId') appId: string, @Request() req) {
        const data = await this.sourcemapTokenService.listTokens({ appId, userId: req.user.id })
        return { success: true, data }
    }

    @Post('/token')
    @UseGuards(AuthGuard('jwt'))
    async createToken(@Body() body: CreateSourcemapTokenDto, @Request() req) {
        const data = await this.sourcemapTokenService.createToken({
            appId: body.appId,
            name: body.name,
            userId: req.user.id,
        })
        return { success: true, data }
    }

    @Delete('/token/:id')
    @UseGuards(AuthGuard('jwt'))
    async revokeToken(@Param('id') id: string, @Request() req) {
        const data = await this.sourcemapTokenService.revokeToken({ id: Number(id), userId: req.user.id })
        return { success: true, data }
    }

    @Delete('/:id')
    @UseGuards(AuthGuard('jwt'))
    async delete(@Param('id') id: string, @Request() req) {
        const data = await this.sourcemapService.delete({ id: Number(id), userId: req.user.id })
        return { success: true, data }
    }
}
