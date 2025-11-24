'use client'

import { useQuery } from '@tanstack/react-query'

import AppAreaChart from '@/components/AppAreaChart'
import AppBarChart from '@/components/AppBarChart'
import AppLineChart from '@/components/AppLineChart'
import type { Application, ApplicationListResponse } from '@/types/application'

export default function Home() {
    const { data } = useQuery<ApplicationListResponse>({
        queryKey: ['applications'],
        queryFn: async () => {
            const res = await fetch('/api/application', { method: 'GET' })
            const data = await res.json()
            return data
        },
    })

    return (
        <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-4">
            <div className="bg-primary-foreground p-4 rounded-lg">
                <AppAreaChart />
            </div>
            <div className="bg-primary-foreground p-4 rounded-lg">
                <AppBarChart />
            </div>
            <div className="bg-primary-foreground p-4 rounded-lg">
                <AppLineChart />
            </div>
            <div className="bg-primary-foreground p-4 rounded-lg">
                {data?.application?.map((item: Application) => (
                    <div key={item.id} className="mb-2 p-2 border rounded">
                        <h3 className="font-bold">{item.name}</h3>
                        <p className="text-sm text-muted-foreground">{item.description}</p>
                        <p className="text-xs">App ID: {item.appId}</p>
                    </div>
                ))}
            </div>
            <div className="bg-primary-foreground p-4 rounded-lg">Test</div>
            <div className="bg-primary-foreground p-4 rounded-lg">Test</div>
        </div>
    )
}
