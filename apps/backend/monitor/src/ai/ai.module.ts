import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'

import { ApplicationModule } from '../application/application.module'
import { AiController } from './ai.controller'
import { AiService } from './ai.service'
import { AIDatasetEntity } from './entity/ai-dataset.entity'
import { AIDatasetItemEntity } from './entity/ai-dataset-item.entity'
import { AIExperimentEntity } from './entity/ai-experiment.entity'
import { AIExperimentRunEntity } from './entity/ai-experiment-run.entity'
import { AIPromptEntity } from './entity/ai-prompt.entity'
import { AIPromptVersionEntity } from './entity/ai-prompt-version.entity'

@Module({
    imports: [
        ApplicationModule,
        TypeOrmModule.forFeature([
            AIPromptEntity,
            AIPromptVersionEntity,
            AIDatasetEntity,
            AIDatasetItemEntity,
            AIExperimentEntity,
            AIExperimentRunEntity,
        ]),
    ],
    controllers: [AiController],
    providers: [AiService],
})
export class AiModule {}
