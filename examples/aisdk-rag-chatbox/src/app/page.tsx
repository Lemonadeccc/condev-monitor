export default function Home() {
    return (
        <div className="flex h-[calc(100vh-65px)] items-center justify-center bg-zinc-50 font-sans dark:bg-black">
            <main className="flex w-full max-w-3xl flex-col items-center justify-center gap-6 px-16 py-16">
                <h1 className="text-3xl font-semibold leading-10 tracking-tight text-black dark:text-zinc-50">Welcome to RAG Chatbot.</h1>
            </main>
        </div>
    )
}
