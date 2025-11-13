'use client'

import { CartesianGrid, LabelList, Line, LineChart, XAxis } from 'recharts'

import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card'

const chartData = [
    { month: 'January', desktop: 186, mobile: 80 },
    { month: 'February', desktop: 305, mobile: 200 },
    { month: 'March', desktop: 237, mobile: 120 },
    { month: 'April', desktop: 73, mobile: 190 },
    { month: 'May', desktop: 209, mobile: 130 },
    { month: 'June', desktop: 214, mobile: 140 },
]

const chartConfig = {
    desktop: {
        label: 'Desktop',
        color: 'var(--chart-1)',
    },
    mobile: {
        label: 'Mobile',
        color: 'var(--chart-2)',
    },
} satisfies ChartConfig

const AppLineChart = () => {
    return (
        <div className="">
            <Card>
                <CardHeader>
                    <CardTitle>Area Chart - Axes</CardTitle>
                    <CardDescription>Showing total visitors for the last 6 months</CardDescription>
                </CardHeader>
                <CardContent>
                    <h1 className="text-lg font-medium mb-6">Total</h1>
                    <ChartContainer config={chartConfig} className="min-h-[200px] w-full">
                        <LineChart accessibilityLayer data={chartData}>
                            <CartesianGrid vertical={false} />
                            <XAxis
                                dataKey="month"
                                tickLine={false}
                                axisLine={false}
                                tickMargin={8}
                                tickFormatter={value => value.slice(0, 3)}
                            />
                            <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="line" />} />
                            <Line
                                dataKey="desktop"
                                type="natural"
                                stroke="var(--color-desktop)"
                                strokeWidth={2}
                                dot={{
                                    fill: 'var(--color-desktop)',
                                }}
                                activeDot={{
                                    r: 6,
                                }}
                            >
                                <LabelList position="top" offset={12} className="fill-foreground" fontSize={12} />
                            </Line>
                        </LineChart>
                    </ChartContainer>
                </CardContent>
            </Card>
        </div>
    )
}

export default AppLineChart
