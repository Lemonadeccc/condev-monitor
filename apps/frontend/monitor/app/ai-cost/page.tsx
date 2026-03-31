'use client'

import { useQuery } from '@tanstack/react-query'
import { DollarSign } from 'lucide-react'
import { useState } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from 'recharts'

import { AIMonitorHeader, AIMonitorPage, AIPanelCard, AIStatCard, AIStateMessage } from '@/components/ai/page-shell'
import { useAuth } from '@/components/providers'
import { Button } from '@/components/ui/button'
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useApplications } from '@/hooks/use-applications'

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

const RANGE_OPTIONS = [
    { label: 'Last 24h', value: '1d' },
    { label: 'Last 7d', value: '7d' },
    { label: 'Last 30d', value: '30d' },
]

const COLORS = ['hsl(var(--chart-1))', 'hsl(var(--chart-2))', 'hsl(var(--chart-3))', 'hsl(var(--chart-4))', 'hsl(var(--chart-5))']

function rangeToFrom(range: string): string {
    const ms = { '1d': 86400000, '7d': 7 * 86400000, '30d': 30 * 86400000 }[range] ?? 86400000
    return new Date(Date.now() - ms).toISOString()
}

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
    const [selectedAppId, setSelectedAppId] = useState<string | null>(null)
    const [range, setRange] = useState('7d')

    const appId = selectedAppId ?? applications[0]?.appId ?? null

    const costQuery = useQuery<CostApiResponse>({
        queryKey: ['ai-cost', appId, range],
        enabled: !!appId,
        queryFn: async () => {
            const params = new URLSearchParams({ appId: appId!, from: rangeToFrom(range) })
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
                    <div className="flex items-center gap-2">
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="default" size="sm">
                                    {RANGE_OPTIONS.find(r => r.value === range)?.label ?? range}
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                                <DropdownMenuLabel>Time Range</DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                {RANGE_OPTIONS.map(opt => (
                                    <DropdownMenuItem key={opt.value} onClick={() => setRange(opt.value)}>
                                        {opt.label}
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuContent>
                        </DropdownMenu>
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="default" size="sm">
                                    {applications.find(a => a.appId === appId)?.name ?? 'Select App'}
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                                <DropdownMenuLabel>Application</DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                {applications.map(app => (
                                    <DropdownMenuItem key={app.appId} onClick={() => setSelectedAppId(app.appId)}>
                                        {app.name}
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
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
