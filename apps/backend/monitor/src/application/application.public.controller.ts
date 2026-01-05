import { Controller, Get, Query } from '@nestjs/common'

import { ApplicationService } from './application.service'

@Controller('/application/public')
export class ApplicationPublicController {
    constructor(private readonly applicationService: ApplicationService) {}

    @Get('/config')
    async config(@Query('appId') appId: string) {
        return this.applicationService.publicConfig({ appId })
    }
}
