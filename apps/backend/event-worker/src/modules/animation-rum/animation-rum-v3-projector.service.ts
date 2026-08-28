import { validateAnimationRumV3KafkaMessage } from '@condev-monitor/animation-rum-ingest'
import { Injectable } from '@nestjs/common'

import { ClickhouseWriterService } from '../clickhouse/clickhouse-writer.service'
import { AnimationRumValidationError } from './animation-rum-projector.service'

@Injectable()
export class AnimationRumV3ProjectorService {
    constructor(private readonly clickhouseWriter: ClickhouseWriterService) {}

    async handleEnvelope(rawEnvelope: unknown, messageKey: string | null): Promise<void> {
        const validation = validateAnimationRumV3KafkaMessage({
            key: messageKey,
            envelope: rawEnvelope,
        })
        if (!validation.ok) throw new AnimationRumValidationError(validation.errors)

        await this.clickhouseWriter.insertAnimationRumV3(validation.value)
    }
}
