'use client'

import { ArrowRight } from 'lucide-react'

import { AI_NATIVE_SELECT_CLASS } from '@/components/ai/page-shell'
import { formatLabComparisonRunLabel, type LabComparisonSelectionState } from '@/lib/lab-comparison'
import type { LabRun } from '@/types/lab'

type LabComparisonSelectorsProps = {
    runs: readonly LabRun[]
    beforeRunId: string
    afterRunId: string
    selectionState: LabComparisonSelectionState
    disabled?: boolean
    onBeforeChange: (runId: string) => void
    onAfterChange: (runId: string) => void
}

function RunSelect(props: {
    id: string
    label: string
    sublabel: string
    value: string
    runs: readonly LabRun[]
    excludedRunId: string
    disabled: boolean
    onChange: (value: string) => void
}) {
    const { id, label, sublabel, value, runs, excludedRunId, disabled, onChange } = props
    return (
        <div className="grid min-w-0 gap-2">
            <label className="text-sm font-medium" htmlFor={id}>
                {label} <span className="font-normal text-muted-foreground">/ {sublabel}</span>
            </label>
            <select
                id={id}
                className={AI_NATIVE_SELECT_CLASS}
                value={value}
                disabled={disabled}
                onChange={event => onChange(event.target.value)}
            >
                <option value="">请选择一次 completed 运行 / Select a completed run</option>
                {runs.map(run => (
                    <option key={run.runId} value={run.runId} disabled={Boolean(excludedRunId) && run.runId === excludedRunId}>
                        {formatLabComparisonRunLabel(run)}
                    </option>
                ))}
            </select>
        </div>
    )
}

export function LabComparisonSelectors({
    runs,
    beforeRunId,
    afterRunId,
    selectionState,
    disabled = false,
    onBeforeChange,
    onAfterChange,
}: LabComparisonSelectorsProps) {
    const statusMessage =
        selectionState === 'same-run'
            ? 'Before 和 After 不能是同一次运行。/ Before and After must be different runs.'
            : selectionState === 'unknown-run'
              ? 'URL 中的运行不属于当前应用或尚未 completed，请重新选择。/ A URL selection is unavailable for this app.'
              : selectionState === 'incomplete'
                ? '请显式选择两次运行；系统不会自动猜测“最新”结果。/ Select both runs explicitly; latest is never inferred.'
                : '已选择两次独立运行，正在核验测量条件。/ Two distinct runs selected; measurement conditions are being checked.'

    return (
        <div className="grid gap-4">
            <div className="grid items-end gap-3 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
                <RunSelect
                    id="lab-comparison-before"
                    label="基线"
                    sublabel="Before"
                    value={beforeRunId}
                    runs={runs}
                    excludedRunId={afterRunId}
                    disabled={disabled}
                    onChange={onBeforeChange}
                />
                <div className="hidden h-10 items-center justify-center px-1 text-muted-foreground lg:flex" aria-hidden="true">
                    <ArrowRight className="h-5 w-5" />
                </div>
                <RunSelect
                    id="lab-comparison-after"
                    label="变更后"
                    sublabel="After"
                    value={afterRunId}
                    runs={runs}
                    excludedRunId={beforeRunId}
                    disabled={disabled}
                    onChange={onAfterChange}
                />
            </div>
            <p
                className={
                    selectionState === 'same-run' || selectionState === 'unknown-run'
                        ? 'text-sm text-destructive'
                        : 'text-sm text-muted-foreground'
                }
                role={selectionState === 'same-run' || selectionState === 'unknown-run' ? 'alert' : 'status'}
            >
                {statusMessage}
            </p>
        </div>
    )
}
