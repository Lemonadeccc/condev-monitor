/* eslint-disable react-refresh/only-export-components */
import './globals.css'

import type { Metadata } from 'next'
import { cookies } from 'next/headers'

import { ClientLayout } from '@/components/ClientLayout'
import { QueryProvider, ThemeProvider } from '@/components/providers'

export const metadata: Metadata = {
    title: {
        default: 'Condev Monitor',
        template: '%s · Condev Monitor',
    },
    description: '面向前端错误、性能、动效与可复现实验的可观测平台。',
}

export default async function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode
}>) {
    const cookieStore = await cookies()
    const defaultOpen = cookieStore.get('sidebar_state')?.value === 'true'

    return (
        <html lang="zh-CN" suppressHydrationWarning>
            <body className="antialiased flex">
                <QueryProvider>
                    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
                        <ClientLayout defaultOpen={defaultOpen}>{children}</ClientLayout>
                    </ThemeProvider>
                </QueryProvider>
            </body>
        </html>
    )
}
