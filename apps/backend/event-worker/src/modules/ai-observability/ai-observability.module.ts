import { Module } from '@nestjs/common'

import { AiProjectorService } from './ai-projector.service'

@Module({
    providers: [AiProjectorService],
    exports: [AiProjectorService],
})
export class AiObservabilityModule {}
