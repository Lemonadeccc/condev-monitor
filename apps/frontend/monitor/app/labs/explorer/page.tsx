'use client'

import { ArrowLeft, FileJson, Radar } from 'lucide-react'
import Link from 'next/link'
import { type ChangeEvent, useState } from 'react'

import { AIMonitorHeader, AIMonitorPage, AIPanelCard } from '@/components/ai/page-shell'
import { LabActiveExplorationViewer } from '@/components/lab/lab-active-exploration-viewer'
import { useAuth } from '@/components/providers'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { type LabActiveExplorationSession, parseLabActiveExploration } from '@/lib/lab-active-exploration'

const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024

export default function LabActiveExplorerPage() {
    const { user, loading } = useAuth()
    const [session, setSession] = useState<LabActiveExplorationSession | null>(null)
    const [fileName, setFileName] = useState('')
    const [error, setError] = useState('')

    const selectArtifact = async (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (!file) return
        setError('')
        if (file.size > MAX_ARTIFACT_BYTES) {
            setSession(null)
            setError('文件超过 8 MiB，本地查看器已拒绝读取。请缩小探索边界后重新生成。')
            return
        }
        try {
            const parsed = parseLabActiveExploration(JSON.parse(await file.text()) as unknown)
            setSession(parsed)
            setFileName(file.name)
        } catch (cause) {
            setSession(null)
            setFileName('')
            setError(cause instanceof Error ? `无法读取探索 artifact：${cause.message}` : '无法读取探索 artifact。')
        }
    }

    if (loading) return <div className="text-sm text-muted-foreground">正在加载…</div>
    if (!user) return null

    return (
        <AIMonitorPage>
            <AIMonitorHeader
                icon={Radar}
                title="主动动效探索"
                description="在当前浏览器内存中查看 Runner 生成的 local-only 或 upload-safe artifact；文件不会自动上传到 Monitor 后端。"
                actions={
                    <Button asChild variant="outline" size="sm">
                        <Link href="/labs">
                            <ArrowLeft aria-hidden="true" /> 返回 Labs
                        </Link>
                    </Button>
                }
            />

            <AIPanelCard
                title="打开本地探索结果"
                description="选择 animation-exploration.local.json 可查看 selector/URL；需要共享时只使用 upload-safe 文件。"
                headerActions={
                    fileName ? <span className="max-w-72 truncate font-mono text-xs text-muted-foreground">{fileName}</span> : null
                }
            >
                <label className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-8 text-center hover:bg-muted/20">
                    <FileJson className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
                    <span className="text-sm font-medium">选择 Active Explorer JSON</span>
                    <span className="max-w-2xl text-xs leading-5 text-muted-foreground">
                        解析、筛选和展示都在当前页面完成；不会调用上传接口，不会持久化 selector、URL、截图哈希或状态回放路径。
                    </span>
                    <Input className="sr-only" type="file" accept="application/json,.json" onChange={selectArtifact} />
                </label>
                {error ? (
                    <p className="mt-3 text-sm text-destructive" role="alert">
                        {error}
                    </p>
                ) : null}
            </AIPanelCard>

            {session ? <LabActiveExplorationViewer key={fileName} session={session} /> : null}
        </AIMonitorPage>
    )
}
