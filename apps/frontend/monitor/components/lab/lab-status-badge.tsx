import { Badge } from '@/components/ui/badge'
import { labRunStatusLabel } from '@/lib/lab'
import type { LabRunStatus } from '@/types/lab'

function statusVariant(status: LabRunStatus) {
    switch (status) {
        case 'completed':
            return 'success' as const
        case 'partial':
        case 'queued':
        case 'running':
            return 'warning' as const
        case 'failed':
            return 'destructive' as const
        default:
            return 'outline' as const
    }
}

export function LabStatusBadge({ status }: { status: LabRunStatus }) {
    return <Badge variant={statusVariant(status)}>{labRunStatusLabel(status)}</Badge>
}
