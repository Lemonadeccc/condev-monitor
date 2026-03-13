import { Bot, Bug, Home, Play, User2, Zap } from 'lucide-react'
import Image from 'next/image'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import React from 'react'

import { useAuth } from '@/components/providers'

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
]

const AppSidebar = () => {
    const { user } = useAuth()
    const pathname = usePathname()
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
                                return (
                                    <SidebarMenuItem key={item.title}>
                                        <SidebarMenuButton asChild isActive={active}>
                                            <Link href={item.url}>
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
