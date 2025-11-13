import AppAreaChart from '@/components/AppAreaChart'
import AppBarChart from '@/components/AppBarChart'
import AppLineChart from '@/components/AppLineChart'

export default function Home() {
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
            <div className="bg-primary-foreground p-4 rounded-lg">Test</div>
            <div className="bg-primary-foreground p-4 rounded-lg">Test</div>
            <div className="bg-primary-foreground p-4 rounded-lg">Test</div>
        </div>
    )
}
