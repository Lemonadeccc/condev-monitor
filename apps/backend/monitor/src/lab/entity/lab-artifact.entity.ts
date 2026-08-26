import { Column, Entity, Index, PrimaryColumn } from 'typeorm'

import type { LabArtifactKind } from '../lab.contracts'

@Entity('animation_lab_artifact')
@Index('animation_lab_artifact_run_idx', ['runId', 'createdAt'])
@Index('animation_lab_artifact_run_idempotency_unique', ['runId', 'idempotencyKeyHash'], { unique: true })
export class LabArtifactEntity {
    @PrimaryColumn({ type: 'uuid' })
    id: string

    @Column({ type: 'uuid' })
    runId: string

    @Column({ type: 'varchar', length: 80 })
    appId: string

    @Column({ type: 'varchar', length: 40 })
    kind: LabArtifactKind

    @Column({ type: 'varchar', length: 120 })
    mimeType: string

    @Column({ type: 'varchar', length: 16, default: 'identity' })
    encoding: 'identity' | 'gzip'

    @Column({ type: 'bigint' })
    byteSize: string

    @Column({ type: 'varchar', length: 64 })
    sha256: string

    @Column({ type: 'varchar', length: 64 })
    idempotencyKeyHash: string

    @Column({ type: 'text' })
    storageKey: string

    @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
    createdAt: Date

    @Column({ type: 'timestamptz' })
    expiresAt: Date
}
