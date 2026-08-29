import { Column, Entity, Index, PrimaryColumn, Unique } from 'typeorm'

@Entity('animation_lab_baseline_binding')
@Unique('animation_lab_baseline_binding_app_key_version_unique', ['appId', 'bindingKey', 'version'])
@Index('animation_lab_baseline_binding_app_key_active_unique', ['appId', 'bindingKey'], {
    unique: true,
    where: '"active" = true',
})
@Index('animation_lab_baseline_binding_app_active_idx', ['appId', 'active'])
export class LabBaselineBindingEntity {
    @PrimaryColumn({ type: 'uuid' })
    id: string

    @Column({ type: 'varchar', length: 80 })
    appId: string

    @Column({ type: 'int' })
    createdBy: number

    @Column({ type: 'varchar', length: 120 })
    bindingKey: string

    @Column({ type: 'int' })
    version: number

    @Column({ type: 'varchar', length: 120 })
    scenarioKey: string

    @Column({ type: 'varchar', length: 160 })
    routeKey: string

    @Column({ type: 'uuid' })
    baselineRunId: string

    @Column({ type: 'uuid' })
    policyId: string

    @Column({ type: 'varchar', length: 64 })
    comparisonContextDigest: string

    @Column({ type: 'boolean', default: true })
    active: boolean

    @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
    createdAt: Date
}
