'use client'
import { SignInButton, SignOutButton, SignUpButton, SignedIn, SignedOut, useAuth } from '@clerk/nextjs'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Button } from './ui/button'

export const Navigation = () => {
    const { sessionClaims } = useAuth()
    const pathname = usePathname()
    const isAdmin = sessionClaims?.metadata?.role === 'admin'
    const showUpload = isAdmin && pathname === '/chat'
    const showChat = isAdmin && pathname === '/upload'

    return (
        <nav className="border-b border-[var(oklch(0.145 0 0))]/10">
            <div className="flex container h-16 items-center justify-between px-4 mx-auto">
                <div className="text-xl font-semibold">RAG Chatbot</div>

                <div className="flex gap-2">
                    <SignedOut>
                        <SignInButton mode="modal" forceRedirectUrl="/chat">
                            <Button variant="ghost">Sign In</Button>
                        </SignInButton>
                        <SignUpButton mode="modal">
                            <Button>Sign Up</Button>
                        </SignUpButton>
                    </SignedOut>

                    <SignedIn>
                        {showUpload && (
                            <Button asChild variant="outline">
                                <Link href="/upload">Upload</Link>
                            </Button>
                        )}
                        {showChat && (
                            <Button asChild variant="outline">
                                <Link href="/chat">Chat</Link>
                            </Button>
                        )}
                        <SignOutButton>
                            <Button variant="outline">Sign Out</Button>
                        </SignOutButton>
                    </SignedIn>
                </div>
            </div>
        </nav>
    )
}
