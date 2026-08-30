'use client'

import { Activity, AlertTriangle, MousePointerClick, Route, ScanSearch } from 'lucide-react'
import { useMemo, useState } from 'react'

import { AIPanelCard, AIStatCard, AIStateMessage } from '@/components/ai/page-shell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
    activeExplorationMotionFamilies,
    type LabActiveExplorationEdge,
    type LabActiveExplorationMotion,
    type LabActiveExplorationSession,
} from '@/lib/lab-active-exploration'
import { cn } from '@/lib/utils'

type ViewMode = 'actions' | 'motions'
const LIST_PAGE_SIZE = 200

function duration(value: number | undefined): string {
    if (value === undefined) return '—'
    if (value < 1_000) return `${Math.round(value)} ms`
    return `${(value / 1_000).toFixed(2)} s`
}

function actionLabel(kind: LabActiveExplorationEdge['action']['kind']): string {
    const labels: Record<LabActiveExplorationEdge['action']['kind'], string> = {
        load: '页面加载',
        click: '点击',
        hover: '悬停',
        scroll: '滚动',
        'pointer-path': '指针轨迹',
        resize: '窗口缩放',
        press: '键盘按键',
    }
    return labels[kind]
}

function statusVariant(status: LabActiveExplorationEdge['status'] | LabActiveExplorationMotion['status']) {
    if (status === 'executed' || status === 'completed') return 'success' as const
    if (status === 'failed' || status === 'cancelled') return 'destructive' as const
    if (status === 'timed-out' || status === 'quarantined' || status === 'partial') return 'warning' as const
    return 'secondary' as const
}

function Metadata({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
    return (
        <div className="min-w-0 rounded-md border bg-muted/10 p-3">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className={cn('mt-1 break-words text-sm font-medium', mono && 'font-mono text-xs')}>{value}</dd>
        </div>
    )
}

function LimitationList({ values }: { values: readonly string[] }) {
    if (!values.length) return <p className="text-sm text-muted-foreground">没有额外限制代码。</p>
    return (
        <div className="flex flex-wrap gap-2">
            {values.map(value => (
                <Badge key={value} variant="outline" className="font-mono font-normal">
                    {value}
                </Badge>
            ))}
        </div>
    )
}

function EdgeDetail({ edge, session }: { edge: LabActiveExplorationEdge; session: LabActiveExplorationSession }) {
    const route = session.routes.find(candidate => candidate.routeId === edge.routeId)
    const motions = edge.motionIds
        .map(motionId => session.motions.find(motion => motion.motionId === motionId))
        .filter((motion): motion is LabActiveExplorationMotion => Boolean(motion))

    return (
        <div className="space-y-6">
            <div className="flex flex-wrap items-center gap-2">
                <Badge variant={statusVariant(edge.status)}>{edge.status}</Badge>
                <Badge variant="outline">{actionLabel(edge.action.kind)}</Badge>
                <span className="font-mono text-xs text-muted-foreground">{edge.edgeId}</span>
            </div>
            <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                <Metadata label="路由" value={route?.routeKey ?? edge.routeId} mono />
                <Metadata label="状态变化" value={`${edge.fromStateId} → ${edge.toStateId ?? '未建立'}`} mono />
                <Metadata label="动作窗口" value={duration(Math.max(0, edge.endedAtMs - edge.startedAtMs))} />
                <Metadata label="关联动效" value={motions.length.toLocaleString()} />
                <Metadata label="已拦截变更请求" value={edge.blockedMutationRequests.toLocaleString()} />
                <Metadata label="探索深度" value={edge.depth.toLocaleString()} />
            </dl>

            {route?.localUrl || edge.action.selector ? (
                <section className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-4">
                    <h3 className="text-sm font-semibold">仅本地证据</h3>
                    {route?.localUrl ? <p className="mt-2 break-all font-mono text-xs">URL: {route.localUrl}</p> : null}
                    {edge.action.selector ? <p className="mt-2 break-all font-mono text-xs">selector: {edge.action.selector}</p> : null}
                    <p className="mt-2 text-xs text-muted-foreground">这些字段只应保存在本机 artifact；upload-safe 文件不会包含它们。</p>
                </section>
            ) : null}

            <section>
                <h3 className="text-sm font-semibold">本次动作观测到的动效</h3>
                {motions.length ? (
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                        {motions.map(motion => (
                            <div key={motion.motionId} className="rounded-md border p-3">
                                <div className="flex items-center justify-between gap-2">
                                    <span className="font-medium">{motion.family}</span>
                                    <Badge variant={statusVariant(motion.status)}>{motion.status}</Badge>
                                </div>
                                <p className="mt-2 font-mono text-xs text-muted-foreground">{motion.motionId}</p>
                            </div>
                        ))}
                    </div>
                ) : (
                    <p className="mt-2 text-sm text-muted-foreground">这个动作窗口没有形成可分类的动效证据。</p>
                )}
            </section>

            <section>
                <h3 className="mb-3 text-sm font-semibold">限制与审核事项</h3>
                <LimitationList values={edge.limitations} />
            </section>
        </div>
    )
}

function MotionDetail({ motion, session }: { motion: LabActiveExplorationMotion; session: LabActiveExplorationSession }) {
    const edge = session.edges.find(candidate => candidate.edgeId === motion.edgeId)
    const route = session.routes.find(candidate => candidate.routeId === motion.routeId)
    return (
        <div className="space-y-6">
            <div className="flex flex-wrap items-center gap-2">
                <Badge variant={statusVariant(motion.status)}>{motion.status}</Badge>
                <Badge variant="outline">{motion.family}</Badge>
                <Badge variant="secondary">{motion.evidenceConfidence}</Badge>
                <span className="font-mono text-xs text-muted-foreground">{motion.motionId}</span>
            </div>
            <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                <Metadata label="路由" value={route?.routeKey ?? motion.routeId} mono />
                <Metadata label="触发动作" value={edge ? actionLabel(edge.action.kind) : motion.edgeId} />
                <Metadata label="声明时长" value={duration(motion.timing.declaredDurationMs)} />
                <Metadata label="观测活跃时间" value={duration(motion.timing.observedActiveMs)} />
                <Metadata label="迭代" value={motion.timing.iterations?.toString() ?? '—'} />
                <Metadata label="因果边界" value={motion.causality} mono />
            </dl>

            {motion.localOnly?.selector || motion.localOnly?.animationName ? (
                <section className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-4">
                    <h3 className="text-sm font-semibold">仅本地目标证据</h3>
                    {motion.localOnly.selector ? (
                        <p className="mt-2 break-all font-mono text-xs">selector: {motion.localOnly.selector}</p>
                    ) : null}
                    {motion.localOnly.animationName ? (
                        <p className="mt-2 break-all font-mono text-xs">animation: {motion.localOnly.animationName}</p>
                    ) : null}
                </section>
            ) : null}

            <section className="grid gap-5 md:grid-cols-3">
                <div>
                    <h3 className="mb-3 text-sm font-semibold">属性</h3>
                    <LimitationList values={motion.properties} />
                </div>
                <div>
                    <h3 className="mb-3 text-sm font-semibold">生命周期</h3>
                    <LimitationList values={motion.lifecycle} />
                </div>
                <div>
                    <h3 className="mb-3 text-sm font-semibold">证据来源</h3>
                    <LimitationList values={motion.evidenceKinds} />
                </div>
            </section>
            <section>
                <h3 className="mb-3 text-sm font-semibold">限制与审核事项</h3>
                <LimitationList values={motion.limitations} />
            </section>
        </div>
    )
}

export function LabActiveExplorationViewer({ session }: { session: LabActiveExplorationSession }) {
    const [mode, setMode] = useState<ViewMode>('actions')
    const [selectedEdgeId, setSelectedEdgeId] = useState(session.edges[0]?.edgeId ?? '')
    const [selectedMotionId, setSelectedMotionId] = useState(session.motions[0]?.motionId ?? '')
    const [visibleEdgeCount, setVisibleEdgeCount] = useState(LIST_PAGE_SIZE)
    const [visibleMotionCount, setVisibleMotionCount] = useState(LIST_PAGE_SIZE)
    const families = useMemo(() => activeExplorationMotionFamilies(session), [session])
    const visibleEdges = session.edges.slice(0, visibleEdgeCount)
    const visibleMotions = session.motions.slice(0, visibleMotionCount)
    const selectedEdge = session.edges.find(edge => edge.edgeId === selectedEdgeId) ?? session.edges[0]
    const selectedMotion = session.motions.find(motion => motion.motionId === selectedMotionId) ?? session.motions[0]

    return (
        <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                <AIStatCard label="发现路由" value={session.coverage.discoveredRoutes.toLocaleString()} description="同源且有界" />
                <AIStatCard label="语义状态" value={session.coverage.discoveredStates.toLocaleString()} description="不按连续帧膨胀" />
                <AIStatCard label="已执行动作" value={session.coverage.executedEdges.toLocaleString()} description="全部仍需人工审核" />
                <AIStatCard label="观测动效" value={session.coverage.observedMotions.toLocaleString()} description="不是全站完成度" />
            </div>

            <AIPanelCard contentClassName="pt-4">
                <div className="flex gap-3 text-sm">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
                    <div>
                        <p className="font-medium">这是有界的安全可达状态探索，不是“自动覆盖网页全部动画”。</p>
                        <p className="mt-1 text-muted-foreground">{session.coverage.warning}</p>
                        <p className="mt-1 text-muted-foreground">
                            文件分类：{session.dataClassification} · 状态：{session.status} · 停止原因：{session.stopReasons.join(', ')}
                        </p>
                    </div>
                </div>
            </AIPanelCard>

            <AIPanelCard
                title="探索状态图"
                description="左侧选择动作或动效，右侧查看证据、时间和边界。"
                headerActions={
                    <div className="flex gap-1 rounded-md border p-1">
                        <Button variant={mode === 'actions' ? 'secondary' : 'ghost'} size="sm" onClick={() => setMode('actions')}>
                            <MousePointerClick aria-hidden="true" /> 动作 {session.edges.length}
                        </Button>
                        <Button variant={mode === 'motions' ? 'secondary' : 'ghost'} size="sm" onClick={() => setMode('motions')}>
                            <Activity aria-hidden="true" /> 动效 {session.motions.length}
                        </Button>
                    </div>
                }
                contentClassName="p-0"
                headerBorder
            >
                <div className="grid min-h-[520px] lg:grid-cols-[minmax(260px,0.72fr)_minmax(0,1.28fr)]">
                    <div className="max-h-[720px] overflow-y-auto border-b p-2 lg:border-r lg:border-b-0">
                        {mode === 'actions' ? (
                            session.edges.length ? (
                                <div className="space-y-1">
                                    {visibleEdges.map(edge => (
                                        <button
                                            key={edge.edgeId}
                                            type="button"
                                            onClick={() => setSelectedEdgeId(edge.edgeId)}
                                            aria-pressed={selectedEdge?.edgeId === edge.edgeId}
                                            className={cn(
                                                'w-full rounded-md px-3 py-3 text-left transition-colors hover:bg-muted',
                                                selectedEdge?.edgeId === edge.edgeId && 'bg-muted'
                                            )}
                                        >
                                            <div className="flex items-center justify-between gap-2">
                                                <span className="font-medium">{actionLabel(edge.action.kind)}</span>
                                                <Badge variant={statusVariant(edge.status)}>{edge.status}</Badge>
                                            </div>
                                            <p className="mt-1 font-mono text-xs text-muted-foreground">{edge.edgeId}</p>
                                            <p className="mt-1 text-xs text-muted-foreground">
                                                {edge.motionIds.length} 个动效 · {duration(edge.endedAtMs - edge.startedAtMs)}
                                            </p>
                                        </button>
                                    ))}
                                    {visibleEdges.length < session.edges.length ? (
                                        <Button
                                            type="button"
                                            variant="outline"
                                            className="w-full"
                                            onClick={() =>
                                                setVisibleEdgeCount(value => Math.min(session.edges.length, value + LIST_PAGE_SIZE))
                                            }
                                        >
                                            再显示 {Math.min(LIST_PAGE_SIZE, session.edges.length - visibleEdges.length)} 项
                                        </Button>
                                    ) : null}
                                </div>
                            ) : (
                                <AIStateMessage>没有动作记录。</AIStateMessage>
                            )
                        ) : session.motions.length ? (
                            <div className="space-y-1">
                                {visibleMotions.map(motion => (
                                    <button
                                        key={motion.motionId}
                                        type="button"
                                        onClick={() => setSelectedMotionId(motion.motionId)}
                                        aria-pressed={selectedMotion?.motionId === motion.motionId}
                                        className={cn(
                                            'w-full rounded-md px-3 py-3 text-left transition-colors hover:bg-muted',
                                            selectedMotion?.motionId === motion.motionId && 'bg-muted'
                                        )}
                                    >
                                        <div className="flex items-center justify-between gap-2">
                                            <span className="font-medium">{motion.family}</span>
                                            <Badge variant={statusVariant(motion.status)}>{motion.status}</Badge>
                                        </div>
                                        <p className="mt-1 font-mono text-xs text-muted-foreground">{motion.motionId}</p>
                                        <p className="mt-1 text-xs text-muted-foreground">
                                            {duration(motion.timing.observedActiveMs)} · {motion.evidenceConfidence}
                                        </p>
                                    </button>
                                ))}
                                {visibleMotions.length < session.motions.length ? (
                                    <Button
                                        type="button"
                                        variant="outline"
                                        className="w-full"
                                        onClick={() =>
                                            setVisibleMotionCount(value => Math.min(session.motions.length, value + LIST_PAGE_SIZE))
                                        }
                                    >
                                        再显示 {Math.min(LIST_PAGE_SIZE, session.motions.length - visibleMotions.length)} 项
                                    </Button>
                                ) : null}
                            </div>
                        ) : (
                            <AIStateMessage>没有形成可分类的动效证据。</AIStateMessage>
                        )}
                    </div>
                    <article className="min-w-0 p-5 lg:p-6">
                        {mode === 'actions' && selectedEdge ? (
                            <EdgeDetail edge={selectedEdge} session={session} />
                        ) : mode === 'motions' && selectedMotion ? (
                            <MotionDetail motion={selectedMotion} session={session} />
                        ) : (
                            <AIStateMessage>从左侧选择一项查看详情。</AIStateMessage>
                        )}
                    </article>
                </div>
            </AIPanelCard>

            <AIPanelCard
                title="动效类型分布"
                description="按浏览器证据或表面级推断分类；Canvas/WebGL/WebGPU 内部对象仍需 renderer adapter。"
            >
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    {families.map(item => (
                        <div key={item.family} className="flex items-center justify-between rounded-md border p-3">
                            <span className="inline-flex items-center gap-2 text-sm font-medium">
                                {item.family === 'unknown' ? (
                                    <ScanSearch className="h-4 w-4" aria-hidden="true" />
                                ) : (
                                    <Activity className="h-4 w-4" aria-hidden="true" />
                                )}
                                {item.family}
                            </span>
                            <span className="font-mono text-sm">{item.count}</span>
                        </div>
                    ))}
                    {!families.length ? <p className="text-sm text-muted-foreground">没有动效类型数据。</p> : null}
                </div>
                <div className="mt-4 flex items-start gap-2 rounded-md border bg-muted/10 p-3 text-xs text-muted-foreground">
                    <Route className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>路线、状态和动作只表示本轮策略实际到达的图，不表示登录隐藏状态、跨源 iframe 或 Canvas 内部对象已被覆盖。</span>
                </div>
            </AIPanelCard>
        </div>
    )
}
