import type { ReactNode } from 'react'

import { Badge } from '@/components/ui/badge'
import {
    animationRumV2QualityReasonLabel,
    animationRumV2ScopeLabel,
    animationRumV2StatusLabel,
    animationRumV2StatusVariant,
} from '@/lib/animation-rum-v2'
import type { AnimationRumV2MetricStatus, AnimationRumV2QualityReason, AnimationRumV2Scope } from '@/types/animation-v2'

export function AnimationRumV2StatusBadge({ status }: { status: AnimationRumV2MetricStatus }) {
    return <Badge variant={animationRumV2StatusVariant(status)}>{animationRumV2StatusLabel(status)}</Badge>
}

export function AnimationRumV2ScopeBadge({ scope }: { scope: AnimationRumV2Scope }) {
    return <Badge variant={scope === 'page' ? 'secondary' : 'outline'}>{animationRumV2ScopeLabel(scope)}</Badge>
}

export function AnimationRumV2QualityBadges({ reasons }: { reasons: readonly AnimationRumV2QualityReason[] }) {
    if (reasons.length === 0) return <span className="text-muted-foreground">无质量降级原因</span>
    return (
        <div className="flex flex-wrap gap-1.5">
            {reasons.map(reason => (
                <Badge key={reason} variant="warning" title={reason}>
                    {animationRumV2QualityReasonLabel(reason)}
                </Badge>
            ))}
        </div>
    )
}

export function AnimationRumV2Fact({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="rounded-lg border bg-muted/20 p-3">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="mt-1 break-words text-sm font-medium">{children}</dd>
        </div>
    )
}
