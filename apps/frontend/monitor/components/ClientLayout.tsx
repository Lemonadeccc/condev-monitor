'use client'

import { usePathname } from 'next/navigation'

import AppSidebar from '@/components/AppSidebar'
import Navbar from '@/components/Navbar'
import { AuthProvider } from '@/components/providers'
import { SidebarProvider } from '@/components/ui/sidebar'

export function ClientLayout({ children, defaultOpen }: { children: React.ReactNode; defaultOpen: boolean }) {
    const pathname = usePathname()
    const isPublic = ['/login', '/register'].includes(pathname)

    if (isPublic) {
        return <AuthProvider>{children}</AuthProvider>
    }

    return (
        <AuthProvider>
            <SidebarProvider defaultOpen={defaultOpen}>
                <AppSidebar />
                <main className="w-full">
                    <Navbar />
                    <div className="px-4">{children}</div>
                </main>
            </SidebarProvider>
        </AuthProvider>
    )
}
