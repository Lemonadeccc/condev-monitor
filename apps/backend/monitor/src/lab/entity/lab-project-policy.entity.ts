import { Column, Entity, Index, PrimaryColumn, Unique } from 'typeorm'

@Entity('animation_lab_project_policy')
@Unique('animation_lab_project_policy_app_key_version_unique', ['appId', 'policyKey', 'version'])
@Index('animation_lab_project_policy_app_created_idx', ['appId', 'createdAt'])
export class LabProjectPolicyEntity {
    @PrimaryColumn({ type: 'uuid' })
    id: string

    @Column({ type: 'varchar', length: 80 })
    appId: string

    @Column({ type: 'int' })
    createdBy: number

    @Column({ type: 'varchar', length: 120 })
    policyKey: string

    @Column({ type: 'int' })
    version: number

    @Column({ type: 'varchar', length: 120 })
    name: string

    @Column({ type: 'smallint' })
    metricCatalogVersion: number

    @Column({ type: 'varchar', length: 64 })
    digest: string

    @Column({ type: 'text' })
    definition: string

    @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
    createdAt: Date
}
