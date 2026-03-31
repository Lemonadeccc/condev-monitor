import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { DateTimeFilter } from '@/components/ai/date-time-filter'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { MonitorRangePreset } from '@/hooks/use-monitor-scope'
import { cn } from '@/lib/utils'
import type { Application } from '@/types/application'

type AIMonitorHeaderProps = {
    icon: LucideIcon
    title: string
    description: string
    actions?: ReactNode
}

type AIPanelCardProps = {
    title?: string
    description?: string
    children: ReactNode
    className?: string
    contentClassName?: string
    headerClassName?: string
    headerActions?: ReactNode
    headerBorder?: boolean
}

type AIStatCardProps = {
    label: string
    value: ReactNode
    description?: ReactNode
    className?: string
}

export const AI_NATIVE_SELECT_CLASS =
    'w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50'

export const MONITOR_RANGE_OPTIONS: Array<{ label: string; value: MonitorRangePreset }> = [
    { label: '30MIN', value: '30m' },
    { label: '1H', value: '1h' },
    { label: '3H', value: '3h' },
    { label: '1D', value: '1d' },
    { label: '7D', value: '7d' },
    { label: '1M', value: '1m' },
    { label: '1Y', value: '1y' },
]

export function AIMonitorPage({ children }: { children: ReactNode }) {
    return <div className="flex flex-col gap-4 pb-10">{children}</div>
}

export function AIMonitorHeader({ icon: Icon, title, description, actions }: AIMonitorHeaderProps) {
    return (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <header className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                    <Icon className="h-5 w-5" />
                    <h1 className="text-xl font-semibold">{title}</h1>
                </div>
                <p className="text-sm text-muted-foreground">{description}</p>
            </header>
            {actions ? <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">{actions}</div> : null}
        </div>
    )
}

export function AIPanelCard({
    title,
    description,
    children,
    className,
    contentClassName,
    headerClassName,
    headerActions,
    headerBorder = false,
}: AIPanelCardProps) {
    return (
        <Card className={cn('bg-primary-foreground shadow-none', className)}>
            {title || description ? (
                <CardHeader className={cn(headerBorder && 'border-b', headerClassName)}>
                    {headerActions ? (
                        <div className="flex items-center justify-between gap-3">
                            <div>
                                {title ? <CardTitle className="text-base">{title}</CardTitle> : null}
                                {description ? <CardDescription className="mt-1 text-sm">{description}</CardDescription> : null}
                            </div>
                            <div className="flex flex-wrap items-center gap-2">{headerActions}</div>
                        </div>
                    ) : (
                        <>
                            {title ? <CardTitle className="text-base">{title}</CardTitle> : null}
                            {description ? <CardDescription className="text-sm">{description}</CardDescription> : null}
                        </>
                    )}
                </CardHeader>
            ) : null}
            <CardContent className={contentClassName}>{children}</CardContent>
        </Card>
    )
}

export function AIStatCard({ label, value, description, className }: AIStatCardProps) {
    return (
        <AIPanelCard className={className} contentClassName="pt-4">
            <div className="text-sm font-medium text-muted-foreground">{label}</div>
            <div className="mt-1 text-2xl font-semibold text-foreground">{value}</div>
            {description ? <div className="mt-1 text-xs text-muted-foreground">{description}</div> : null}
        </AIPanelCard>
    )
}

export function AIStateMessage({
    children,
    tone = 'muted',
    className,
}: {
    children: ReactNode
    tone?: 'muted' | 'destructive'
    className?: string
}) {
    return (
        <div className={cn('px-6 py-10 text-sm', tone === 'destructive' ? 'text-destructive' : 'text-muted-foreground', className)}>
            {children}
        </div>
    )
}

export function getMonitorRangeLabel(range: MonitorRangePreset) {
    return MONITOR_RANGE_OPTIONS.find(option => option.value === range)?.label ?? range.toUpperCase()
}

export function AIMonitorScopeActions(props: {
    applications: Application[]
    appId: string | null
    onAppChange: (appId: string) => void
    range?: MonitorRangePreset
    onRangeChange?: (range: MonitorRangePreset) => void
    from?: string
    to?: string
    onFromChange?: (value: string) => void
    onToChange?: (value: string) => void
    onClearCustomRange?: () => void
    extraActions?: ReactNode
}) {
    const { applications, appId, onAppChange, range, onRangeChange, from, to, onFromChange, onToChange, onClearCustomRange, extraActions } =
        props

    const hasCustomRange = Boolean(from || to)

    return (
        <div className="flex flex-wrap items-center gap-2">
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button variant="default" size="sm">
                        {applications.find(app => app.appId === appId)?.name ?? 'Select App'}
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                    <DropdownMenuLabel>Application</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {applications.map(app => (
                        <DropdownMenuItem key={app.appId} onClick={() => onAppChange(app.appId)}>
                            {app.name}
                        </DropdownMenuItem>
                    ))}
                </DropdownMenuContent>
            </DropdownMenu>

            {range && onRangeChange ? (
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="default" size="sm">
                            {hasCustomRange ? `Custom · ${getMonitorRangeLabel(range)}` : getMonitorRangeLabel(range)}
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <DropdownMenuLabel>Range</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        {MONITOR_RANGE_OPTIONS.map(option => (
                            <DropdownMenuItem key={option.value} onClick={() => onRangeChange(option.value)}>
                                {option.label}
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuContent>
                </DropdownMenu>
            ) : null}

            {onFromChange ? <DateTimeFilter value={from ?? ''} onChange={onFromChange} placeholder="From" /> : null}
            {onToChange ? <DateTimeFilter value={to ?? ''} onChange={onToChange} placeholder="To" /> : null}
            {hasCustomRange && onClearCustomRange ? (
                <Button variant="outline" size="sm" onClick={onClearCustomRange}>
                    Use Preset
                </Button>
            ) : null}
            {extraActions}
        </div>
    )
}
