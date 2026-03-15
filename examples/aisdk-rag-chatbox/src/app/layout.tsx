import type { Metadata } from 'next'
import './globals.css'
import { ClerkProvider } from '@clerk/nextjs'
import { Navigation } from '@/components/navigation'
import { CondevErrorBoundary } from '@condev-monitor/nextjs'

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
                    <CondevErrorBoundary fallback={<div>Something went wrong.</div>}>{children}</CondevErrorBoundary>
                </body>
            </html>
        </ClerkProvider>
    )
}
