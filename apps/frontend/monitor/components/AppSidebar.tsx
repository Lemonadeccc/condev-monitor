import {
    BookText,
    Bot,
    BrainCircuit,
    Bug,
    ClipboardCheck,
    Database,
    DollarSign,
    FlaskConical,
    Home,
    MessagesSquare,
    Play,
    SquareTerminal,
    User2,
    Users,
    Zap,
} from 'lucide-react'
import Image from 'next/image'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import React from 'react'

import { useAuth } from '@/components/providers'
import { buildMonitorScopeHref } from '@/hooks/use-monitor-scope'

import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarGroupContent,
    SidebarHeader,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarSeparator,
} from './ui/sidebar'

const items = [
    {
        title: 'Overview',
        url: '/',
        icon: Home,
    },
    {
        title: 'Bugs',
        url: '/bugs',
        icon: Bug,
    },
    {
        title: 'Metric',
        url: '/metric',
        icon: Zap,
    },
    {
        title: 'Replays',
        url: '/replays',
        icon: Play,
    },
    {
        title: 'AI Streaming',
        url: '/ai-streaming',
        icon: Bot,
    },
    {
        title: 'AI Traces',
        url: '/ai-traces',
        icon: BrainCircuit,
    },
    {
        title: 'AI Sessions',
        url: '/ai-sessions',
        icon: MessagesSquare,
    },
    {
        title: 'AI Users',
        url: '/ai-users',
        icon: Users,
    },
    {
        title: 'Evaluations',
        url: '/evaluation',
        icon: ClipboardCheck,
    },
    {
        title: 'AI Cost',
        url: '/ai-cost',
        icon: DollarSign,
    },
    {
        title: 'AI Prompts',
        url: '/ai-prompts',
        icon: BookText,
    },
    {
        title: 'AI Datasets',
        url: '/ai-datasets',
        icon: Database,
    },
    {
        title: 'AI Experiments',
        url: '/ai-experiments',
        icon: FlaskConical,
    },
    {
        title: 'AI Playground',
        url: '/ai-playground',
        icon: SquareTerminal,
    },
]

const AppSidebar = () => {
    const { user } = useAuth()
    const pathname = usePathname()
    const searchParams = useSearchParams()
    return (
        <Sidebar collapsible="icon">
            <SidebarHeader className="py-4">
                <SidebarMenu>
                    <SidebarMenuItem>
                        <SidebarMenuButton asChild>
                            <Link href="/">
                                <Image src="/favicon.ico" alt="logo" width={20} height={20} />
                                <span>Condev Monitor</span>
                            </Link>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                </SidebarMenu>
            </SidebarHeader>

            <SidebarSeparator />

            <SidebarContent>
                <SidebarGroup>
                    <SidebarGroupContent>
                        <SidebarMenu>
                            {items.map(item => {
                                const active = item.url === '/' ? pathname === '/' : pathname.startsWith(item.url)
                                const href = item.url === '/' ? item.url : buildMonitorScopeHref(item.url, searchParams)
                                return (
                                    <SidebarMenuItem key={item.title}>
                                        <SidebarMenuButton asChild isActive={active}>
                                            <Link href={href}>
                                                <item.icon />
                                                <span>{item.title}</span>
                                            </Link>
                                        </SidebarMenuButton>
                                    </SidebarMenuItem>
                                )
                            })}
                        </SidebarMenu>
                    </SidebarGroupContent>
                </SidebarGroup>
            </SidebarContent>

            <SidebarFooter>
                <SidebarMenu>
                    <SidebarMenuItem>
                        <SidebarMenuButton>
                            <User2 />
                            {user?.email || 'User'}
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                </SidebarMenu>
            </SidebarFooter>
        </Sidebar>
    )
}

export default AppSidebar
