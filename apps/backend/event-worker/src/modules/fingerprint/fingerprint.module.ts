import { Module } from '@nestjs/common'

import { EmbeddingService } from './embedding.service'
import { FingerprintService } from './fingerprint.service'
import { TfIdfService } from './tfidf.service'

@Module({
    providers: [FingerprintService, EmbeddingService, TfIdfService],
    exports: [FingerprintService, EmbeddingService, TfIdfService],
})
export class FingerprintModule {}
