import type { Metadata } from 'next'
import './globals.css'
import { ClerkProvider } from '@clerk/nextjs'
import { Navigation } from '@/components/navigation'
import { MonitorInit } from '@/components/monitor-init'

export const metadata: Metadata = {
    title: 'RAG Chatbot',
    description: 'A RAG chatbot that answers questions about the AISDK documentation.',
}

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode
}>) {
    return (
        <ClerkProvider>
            <html lang="en">
                <body className="antialiased">
                    <Navigation />
                    <MonitorInit />
                    {children}
                </body>
            </html>
        </ClerkProvider>
    )
}
