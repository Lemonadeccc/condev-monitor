'use client'

import { useQuery } from '@tanstack/react-query'
import { DollarSign } from 'lucide-react'
import { useMemo } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from 'recharts'

import { AIMonitorHeader, AIMonitorPage, AIMonitorScopeActions, AIPanelCard, AIStatCard, AIStateMessage } from '@/components/ai/page-shell'
import { useAuth } from '@/components/providers'
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import { useApplications } from '@/hooks/use-applications'
import { resolveMonitorAppId, resolveMonitorTimeWindow, useMonitorScope } from '@/hooks/use-monitor-scope'

type CostRow = {
    model: string
    provider: string
    cost_currency?: string
    total_input_tokens: number
    total_output_tokens: number
    total_cost: number
    cost_available?: boolean
    cost_source?: 'final' | 'estimated' | 'unknown'
}

type CostApiResponse = {
    success: boolean
    data: CostRow[]
}

const COLORS = ['hsl(var(--chart-1))', 'hsl(var(--chart-2))', 'hsl(var(--chart-3))', 'hsl(var(--chart-4))', 'hsl(var(--chart-5))']

function getCurrencySymbol(currency?: string | null) {
    switch (currency) {
        case 'USD':
            return '$'
        case 'CNY':
            return '¥'
        default:
            return ''
    }
}

function formatCost(amount: number, currency?: string | null) {
    const symbol = getCurrencySymbol(currency)
    const formatted = amount.toFixed(4)
    return symbol ? `${symbol}${formatted}` : `${formatted} ${currency ?? ''}`.trim()
}

export default function AiCostPage() {
    const { user } = useAuth()
    const { listQuery } = useApplications({ enabled: !!user })
    const applications = listQuery.data?.data?.applications ?? []
    const { selectedAppId, setSelectedAppId, range, setRange, from, setFrom, to, setTo, clearCustomRange } = useMonitorScope('30m')

    const appId = resolveMonitorAppId(applications, selectedAppId) || null
    const timeWindow = useMemo(() => resolveMonitorTimeWindow(range, from, to), [from, range, to])

    const costQuery = useQuery<CostApiResponse>({
        queryKey: ['ai-cost', appId, range, timeWindow.from, timeWindow.to],
        enabled: !!appId,
        queryFn: async () => {
            const params = new URLSearchParams({ appId: appId! })
            params.set('from', timeWindow.from)
            params.set('to', timeWindow.to)
            const res = await fetch(`/api/ai/cost?${params.toString()}`)
            if (!res.ok) throw new Error('Failed to load cost data')
            return res.json()
        },
    })

    const rows = costQuery.data?.data ?? []
    const totalTokens = rows.reduce((s, r) => s + r.total_input_tokens + r.total_output_tokens, 0)
    const costAvailable = rows.some(r => r.cost_available)
    const hasEstimatedCost = rows.some(r => r.cost_source === 'estimated')
    const costByCurrency = rows.reduce<Record<string, number>>((acc, row) => {
        if (!row.cost_available || !row.cost_currency) return acc
        acc[row.cost_currency] = (acc[row.cost_currency] ?? 0) + row.total_cost
        return acc
    }, {})
    const totalCostLabel = !costAvailable
        ? '—'
        : Object.entries(costByCurrency)
              .map(([currency, total]) => formatCost(total, currency))
              .join(' • ')

    return (
        <AIMonitorPage>
            <AIMonitorHeader
                icon={DollarSign}
                title="AI Cost"
                description="Track token volume and cost visibility across providers and models."
                actions={
                    <AIMonitorScopeActions
                        applications={applications}
                        appId={appId}
                        onAppChange={setSelectedAppId}
                        range={range}
                        onRangeChange={setRange}
                        from={from}
                        to={to}
                        onFromChange={setFrom}
                        onToChange={setTo}
                        onClearCustomRange={clearCustomRange}
                    />
                }
            />

            <div className="grid grid-cols-2 gap-4">
                <AIStatCard label="Total Cost" value={totalCostLabel} />
                <AIStatCard label="Total Tokens" value={totalTokens.toLocaleString()} />
            </div>

            {rows.length > 0 && (
                <AIPanelCard title="Cost by Model" description="Spend per model in the selected period." contentClassName="pt-0">
                    <ChartContainer config={{}} className="h-48 w-full">
                        <BarChart data={rows} margin={{ left: 0, right: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} />
                            <XAxis dataKey="model" tick={{ fontSize: 12 }} />
                            <YAxis tick={{ fontSize: 12 }} />
                            <ChartTooltip content={<ChartTooltipContent />} />
                            <Bar dataKey="total_cost" name="Cost" radius={4}>
                                {rows.map((_, i) => (
                                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                                ))}
                            </Bar>
                        </BarChart>
                    </ChartContainer>
                </AIPanelCard>
            )}

            <AIPanelCard
                title="Breakdown"
                description={
                    !costAvailable && totalTokens > 0
                        ? 'Cost data is not available for the current traces yet.'
                        : hasEstimatedCost
                          ? 'Estimated rows use pricing rules because a final trace cost was not persisted.'
                          : undefined
                }
                headerBorder
                contentClassName="px-0"
            >
                {costQuery.isLoading ? (
                    <AIStateMessage>Loading...</AIStateMessage>
                ) : rows.length === 0 ? (
                    <AIStateMessage>No cost data found.</AIStateMessage>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead className="bg-muted/40 text-xs text-muted-foreground">
                                <tr className="[&_th]:font-medium">
                                    <th className="text-left px-6 py-3 font-medium">Model</th>
                                    <th className="text-left px-6 py-3 font-medium">Provider</th>
                                    <th className="text-left px-6 py-3 font-medium">Currency</th>
                                    <th className="text-right px-6 py-3 font-medium">Input Tokens</th>
                                    <th className="text-right px-6 py-3 font-medium">Output Tokens</th>
                                    <th className="text-left px-6 py-3 font-medium">Source</th>
                                    <th className="text-right px-6 py-3 font-medium">Cost</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y">
                                {rows.map((r, i) => (
                                    <tr key={i} className="hover:bg-muted/40 transition-colors">
                                        <td className="px-6 py-3 font-medium">{r.model || '—'}</td>
                                        <td className="px-6 py-3 text-muted-foreground">{r.provider || '—'}</td>
                                        <td className="px-6 py-3 text-muted-foreground">{r.cost_currency || '—'}</td>
                                        <td className="px-6 py-3 text-right">{r.total_input_tokens.toLocaleString()}</td>
                                        <td className="px-6 py-3 text-right">{r.total_output_tokens.toLocaleString()}</td>
                                        <td className="px-6 py-3 text-muted-foreground">
                                            {r.cost_source === 'estimated' ? 'Estimated' : r.cost_source === 'final' ? 'Final' : '—'}
                                        </td>
                                        <td className="px-6 py-3 text-right font-medium">
                                            {r.cost_available ? formatCost(r.total_cost, r.cost_currency) : '—'}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </AIPanelCard>
        </AIMonitorPage>
    )
}
