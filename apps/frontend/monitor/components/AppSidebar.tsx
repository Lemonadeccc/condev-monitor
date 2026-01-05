import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@radix-ui/react-dropdown-menu'
import { Bug, Home, Play, User2, Zap } from 'lucide-react'
import Image from 'next/image'
import Link from 'next/link'
import React from 'react'

import { useAuth } from '@/components/providers'

import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarGroupContent,
    SidebarGroupLabel,
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
]

const AppSidebar = () => {
    const { user, logout } = useAuth()
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

            <SidebarSeparator className="w-auto" />

            <SidebarContent>
                <SidebarGroup>
                    <SidebarGroupLabel>Application</SidebarGroupLabel>
                    <SidebarGroupContent>
                        <SidebarMenu>
                            {items.map(item => {
                                return (
                                    <SidebarMenuItem key={item.title}>
                                        <SidebarMenuButton asChild>
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
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <SidebarMenuButton>
                                    <User2 />
                                    {user?.email || 'User'}
                                </SidebarMenuButton>
                            </DropdownMenuTrigger>

                            <DropdownMenuContent align="end">
                                <DropdownMenuItem asChild>
                                    <Link href="/profile">Account</Link>
                                </DropdownMenuItem>
                                <DropdownMenuItem>Setting</DropdownMenuItem>
                                <DropdownMenuItem onClick={() => logout()}>Sign out</DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </SidebarMenuItem>
                </SidebarMenu>
            </SidebarFooter>
        </Sidebar>
    )
}

export default AppSidebar
