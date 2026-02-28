'use client'

import { usePathname } from 'next/navigation'

import AppSidebar from '@/components/AppSidebar'
import Navbar from '@/components/Navbar'
import { AuthProvider, useAuth } from '@/components/providers'
import { SidebarProvider } from '@/components/ui/sidebar'
import { isPublicAuthPath } from '@/lib/auth-routes'

function ProtectedAppShell({ children, defaultOpen }: { children: React.ReactNode; defaultOpen: boolean }) {
    const { user, loading } = useAuth()

    // Wait for auth state before rendering the protected shell to avoid
    // prefetching internal routes and then immediately redirecting to login.
    if (loading || !user) {
        return (
            <div className="flex min-h-screen w-full items-center justify-center text-sm text-muted-foreground">Loading dashboard...</div>
        )
    }

    return (
        <SidebarProvider defaultOpen={defaultOpen}>
            <AppSidebar />
            <main className="w-full">
                <Navbar />
                <div className="px-4">{children}</div>
            </main>
        </SidebarProvider>
    )
}

export function ClientLayout({ children, defaultOpen }: { children: React.ReactNode; defaultOpen: boolean }) {
    const pathname = usePathname()
    const isPublic = isPublicAuthPath(pathname)

    if (isPublic) {
        return <AuthProvider>{children}</AuthProvider>
    }

    return (
        <AuthProvider>
            <ProtectedAppShell defaultOpen={defaultOpen}>{children}</ProtectedAppShell>
        </AuthProvider>
    )
}
