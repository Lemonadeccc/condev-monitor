'use client'

import { useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Copy, KeyRound, Play } from 'lucide-react'
import { type FormEvent, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { copyToClipboard } from '@/lib/clipboard'
import { formatDateTime } from '@/lib/datetime'
import type { LabCreateApiResponse, LabCreateRequest } from '@/types/lab'

const GENERIC_SCENARIO_PATH = 'apps/backend/lab-runner/examples/generic-page.scenario.json'

async function postLabRun(payload: LabCreateRequest): Promise<LabCreateApiResponse> {
    const response = await fetch('/api/labs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    })
    const body = (await response.json().catch(() => null)) as LabCreateApiResponse | null
    if (!response.ok || !body?.success || !body.data.runnerGrant?.token) {
        throw new Error(body?.message || '实验室任务创建失败')
    }
    return body
}

type LabBrowserEngine = LabCreateRequest['browser']

const BROWSER_OPTIONS: ReadonlyArray<{ value: LabBrowserEngine; label: string; note: string }> = [
    { value: 'chromium', label: 'Chromium（完整诊断）', note: '页面指标、CDP 时间线和 Lighthouse' },
    { value: 'firefox', label: 'Firefox（通用指标）', note: '页面指标与动作重放；无 CDP/Lighthouse' },
    { value: 'webkit', label: 'WebKit（通用指标）', note: '页面指标与动作重放；并非真机 Safari' },
]

function buildRunnerCommand(runId: string, serverOrigin: string, browser: LabBrowserEngine) {
    return [
        `printf 'Paste the one-time Runner Grant: ' >&2`,
        'IFS= read -r -s CONDEV_LAB_RUNNER_TOKEN',
        `printf '\\n' >&2`,
        "pnpm --filter '@condev-monitor/animation-lab-runner...' build && \\",
        'CONDEV_LAB_RUNNER_TOKEN="$CONDEV_LAB_RUNNER_TOKEN" node apps/backend/lab-runner/build/cli.js \\',
        `  --config ${GENERIC_SCENARIO_PATH} \\`,
        `  --browser ${browser} \\`,
        '  --out-dir ./lab-results \\',
        `  --server ${serverOrigin} \\`,
        `  --run-id ${runId}`,
    ].join('\n')
}

export function LabRunActions({ appId }: { appId: string }) {
    const queryClient = useQueryClient()
    const [createOpen, setCreateOpen] = useState(false)
    const [name, setName] = useState('动画性能实验')
    const [targetUrl, setTargetUrl] = useState('')
    const [browser, setBrowser] = useState<LabBrowserEngine>('chromium')
    const [submitting, setSubmitting] = useState(false)
    const [requestError, setRequestError] = useState('')
    const [created, setCreated] = useState<LabCreateApiResponse['data'] | null>(null)
    const [copyState, setCopyState] = useState<'token' | 'command' | 'error' | null>(null)

    const clearSensitiveState = () => {
        setCreated(null)
        setCopyState(null)
        setRequestError('')
    }

    const updateOpen = (open: boolean) => {
        if (submitting) return
        setCreateOpen(open)
        if (!open) clearSensitiveState()
        else {
            setRequestError('')
            setCopyState(null)
        }
    }

    const createRun = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        if (submitting) return
        setSubmitting(true)
        setRequestError('')
        setCopyState(null)
        try {
            const response = await postLabRun({ action: 'create', appId, name: name.trim(), targetUrl: targetUrl.trim(), browser })
            setCreated(response.data)
            void queryClient.invalidateQueries({ queryKey: ['lab-runs'] })
        } catch (error) {
            setRequestError(error instanceof Error ? error.message : '实验室任务创建失败')
        } finally {
            setSubmitting(false)
        }
    }

    const copyValue = async (value: string, kind: 'token' | 'command') => {
        setCopyState((await copyToClipboard(value)) ? kind : 'error')
    }

    const disabled = !appId || submitting
    const serverOrigin = typeof window === 'undefined' ? 'http://localhost:3000' : window.location.origin
    const createdBrowser = BROWSER_OPTIONS.some(option => option.value === created?.run.browser)
        ? (created?.run.browser as LabBrowserEngine)
        : browser
    const runnerCommand = created ? buildRunnerCommand(created.run.runId, serverOrigin, createdBrowser) : ''

    return (
        <Dialog open={createOpen} onOpenChange={updateOpen}>
            <DialogTrigger asChild>
                <Button size="sm" disabled={!appId}>
                    <Play aria-hidden="true" /> 新建实验
                </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-2xl">
                {created ? (
                    <div className="grid min-w-0 gap-5">
                        <DialogHeader>
                            <DialogTitle>任务已创建</DialogTitle>
                            <DialogDescription>
                                一次性 Runner Grant 只在这里返回。关闭窗口后会从页面内存清除，平台不会再次显示它。
                            </DialogDescription>
                        </DialogHeader>

                        <div className="flex gap-3 rounded-lg border border-green-500/30 bg-green-500/5 p-4 text-sm">
                            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-green-600 dark:text-green-400" aria-hidden="true" />
                            <div className="min-w-0">
                                <p className="font-medium">本地 runner 可以领取任务了</p>
                                <p className="mt-1 break-all text-xs text-muted-foreground">Run ID：{created.run.runId}</p>
                                <p className="mt-1 text-xs text-muted-foreground">
                                    Grant 过期时间：{formatDateTime(created.runnerGrant.expiresAt)}
                                </p>
                            </div>
                        </div>

                        <section className="grid gap-2" aria-labelledby="lab-runner-grant-title">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <h3 id="lab-runner-grant-title" className="inline-flex items-center gap-2 text-sm font-medium">
                                    <KeyRound className="h-4 w-4" aria-hidden="true" /> 一次性 Runner Grant
                                </h3>
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    onClick={() => copyValue(created.runnerGrant.token, 'token')}
                                >
                                    <Copy aria-hidden="true" /> {copyState === 'token' ? '已复制 Grant' : '复制 Grant'}
                                </Button>
                            </div>
                            <code className="max-h-24 overflow-auto break-all rounded-md border bg-muted/30 p-3 font-mono text-xs">
                                {created.runnerGrant.token}
                            </code>
                        </section>

                        <section className="grid min-w-0 gap-2" aria-labelledby="lab-runner-command-title">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <div>
                                    <h3 id="lab-runner-command-title" className="text-sm font-medium">
                                        Runner 命令
                                    </h3>
                                    <p className="mt-1 text-xs text-muted-foreground">
                                        命令会在终端静默读取 Grant，不把它写进 shell history 或进程参数。平台目标地址会替换示例占位 URL。
                                    </p>
                                </div>
                                <Button type="button" size="sm" variant="outline" onClick={() => copyValue(runnerCommand, 'command')}>
                                    <Copy aria-hidden="true" /> {copyState === 'command' ? '已复制命令' : '复制命令'}
                                </Button>
                            </div>
                            <pre className="max-h-64 overflow-auto whitespace-pre rounded-md border bg-muted/30 p-3 font-mono text-xs leading-5">
                                <code>{runnerCommand}</code>
                            </pre>
                        </section>

                        <p className="text-xs text-muted-foreground" aria-live="polite">
                            {copyState === 'error'
                                ? '浏览器未允许自动复制，请手动选择上面的文本。'
                                : '命令由本地 runner 执行；Monitor 服务不会主动访问目标网页。'}
                        </p>

                        <DialogFooter>
                            <Button type="button" onClick={() => updateOpen(false)}>
                                我已保存，关闭
                            </Button>
                        </DialogFooter>
                    </div>
                ) : (
                    <form className="grid gap-5" onSubmit={createRun}>
                        <DialogHeader>
                            <DialogTitle>创建本地实验任务</DialogTitle>
                            <DialogDescription>
                                平台只登记任务并签发一次性 Grant；随后由你在本机执行 runner，打开目标页面并上传脱敏结果。
                            </DialogDescription>
                        </DialogHeader>
                        <div className="grid gap-2">
                            <Label htmlFor="lab-run-name">任务名称</Label>
                            <Input
                                id="lab-run-name"
                                value={name}
                                onChange={event => setName(event.target.value)}
                                required
                                maxLength={120}
                                autoComplete="off"
                                disabled={submitting}
                            />
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor="lab-browser">浏览器引擎</Label>
                            <select
                                id="lab-browser"
                                value={browser}
                                onChange={event => setBrowser(event.target.value as LabBrowserEngine)}
                                disabled={submitting}
                                className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {BROWSER_OPTIONS.map(option => (
                                    <option key={option.value} value={option.value}>
                                        {option.label}
                                    </option>
                                ))}
                            </select>
                            <p className="text-xs text-muted-foreground">
                                {BROWSER_OPTIONS.find(option => option.value === browser)?.note}
                            </p>
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor="lab-target-url">目标地址</Label>
                            <Input
                                id="lab-target-url"
                                type="url"
                                value={targetUrl}
                                onChange={event => setTargetUrl(event.target.value)}
                                required
                                maxLength={2048}
                                placeholder="http://localhost:5173"
                                autoComplete="url"
                                disabled={submitting}
                            />
                            <p className="text-xs text-muted-foreground">
                                本地 runner 领取任务后会使用这个地址；Monitor 后端本身不会访问它。不要把 token、密码等秘密放进 query 或
                                hash，登录态请留在本地 storage-state。
                            </p>
                        </div>
                        {requestError ? <p className="text-sm text-destructive">{requestError}</p> : null}
                        <DialogFooter>
                            <Button type="button" variant="outline" onClick={() => updateOpen(false)} disabled={submitting}>
                                取消
                            </Button>
                            <Button type="submit" disabled={disabled || !name.trim() || !targetUrl.trim()}>
                                {submitting ? '正在创建…' : '创建并生成 Grant'}
                            </Button>
                        </DialogFooter>
                    </form>
                )}
            </DialogContent>
        </Dialog>
    )
}
