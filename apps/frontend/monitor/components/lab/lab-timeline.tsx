'use client'

import { AlertTriangle, Lightbulb, MousePointer2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { boundTimelineEvents, formatLabDuration } from '@/lib/lab'
import type { LabTimelineCategory, LabTimelineEvent } from '@/types/lab'

const CATEGORY_COLORS: Record<LabTimelineCategory, string> = {
    frame: '#0ea5e9',
    interaction: '#8b5cf6',
    animation: '#22c55e',
    script: '#f59e0b',
    'long-task': '#ef4444',
    'style-layout': '#f97316',
    'paint-composite': '#14b8a6',
    renderer: '#ec4899',
    resource: '#6366f1',
    marker: '#64748b',
    other: '#94a3b8',
}

const CATEGORY_LABELS: Record<LabTimelineCategory, string> = {
    frame: 'Frame',
    interaction: 'Interaction',
    animation: 'Animation',
    script: 'Script',
    'long-task': 'Long Task',
    'style-layout': 'Style / Layout',
    'paint-composite': 'Paint / Composite',
    renderer: 'Canvas / GPU',
    resource: 'Resource',
    marker: 'Marker',
    other: 'Other',
}

const LANE_LABEL_WIDTH = 116
const RIGHT_PADDING = 16
const TOP_PADDING = 32
const BOTTOM_PADDING = 22

type EventHitBox = {
    eventId: string
    x: number
    y: number
    width: number
    height: number
}

function eventLane(event: LabTimelineEvent) {
    return event.lane?.trim() || CATEGORY_LABELS[event.category]
}

function formatStackFrame(frame: NonNullable<LabTimelineEvent['stack']>[number]) {
    const location = frame.fileName
        ? `${frame.fileName}${frame.lineNumber == null ? '' : `:${frame.lineNumber}${frame.columnNumber == null ? '' : `:${frame.columnNumber}`}`}`
        : '未知位置'
    return `${frame.functionName || '(anonymous)'} · ${location}`
}

type TimelineRecommendation = {
    durationContext: string
    nextStep: string
    sourceContext: string
}

function recommendForTimelineEvent(event: LabTimelineEvent): TimelineRecommendation {
    const duration = Math.max(0, event.durationMs)
    const formattedDuration = formatLabDuration(duration)
    const firstFrame = event.stack?.[0]
    const sourceContext = firstFrame
        ? `首个可用栈帧是 ${formatStackFrame(firstFrame)}。可先从这里向调用方回溯，但它只是候选入口，不等同于已确认根因。`
        : '这个事件没有可用栈帧，暂时无法定位到具体源码；可在本地原始 trace 中结合相邻事件和浏览器调用树继续排查。'

    switch (event.category) {
        case 'frame':
            return {
                durationContext:
                    duration > 16.7
                        ? `该帧记录为 ${formattedDuration}，高于 60 Hz 屏幕约 16.7 ms 的单帧参考值；实际预算仍取决于设备刷新率和采样方式。`
                        : `该帧记录为 ${formattedDuration}，未超过 60 Hz 屏幕约 16.7 ms 的参考值；单个样本不足以证明整体流畅。`,
                nextStep: '优先展开同一时间段的 Script、Style / Layout、Paint 和渲染器事件，比较连续慢帧而不是只优化这一帧。',
                sourceContext,
            }
        case 'long-task':
            return {
                durationContext:
                    duration >= 50
                        ? `该主线程任务记录为 ${formattedDuration}，达到 Long Task 常用的 50 ms 边界；其持续时间仍可能包含嵌套事件。`
                        : `该事件记录为 ${formattedDuration}，低于 50 ms 边界；分类可能来自采集器上下文，不能只凭名称断定阻塞程度。`,
                nextStep: '检查同步循环、解析和组件更新，把可中断工作拆批并在帧或任务之间让出主线程；先确认拆分不会破坏交互原子性。',
                sourceContext,
            }
        case 'script':
            return {
                durationContext: `这段脚本事件记录为 ${formattedDuration}；嵌套 trace 事件会重叠，因此这不是该函数的独占 CPU 时间。`,
                nextStep:
                    duration > 16.7
                        ? '先用调用树确认热点，再减少每帧同步计算、缓存稳定结果或拆分非关键工作；不要仅按这个事件跨度删除代码。'
                        : '结合重复次数和父子调用树判断累计成本；短事件高频重复也可能形成帧压力。',
                sourceContext,
            }
        case 'style-layout':
            return {
                durationContext: `样式或布局事件记录为 ${formattedDuration}；它可能是前序 DOM 读写触发的结果，不一定由首个栈帧单独造成。`,
                nextStep: '检查同一帧内交错的布局读取与样式写入，批量读取后再批量写入，并缩小需要重新布局的 DOM 范围。',
                sourceContext,
            }
        case 'paint-composite':
            return {
                durationContext: `绘制或合成事件记录为 ${formattedDuration}；CPU trace 不能单独证明 GPU 是瓶颈。`,
                nextStep: '检查大面积重绘、滤镜、阴影和图层抖动，优先缩小绘制区域；只有验证受益后才保留 will-change，避免盲目增加图层。',
                sourceContext,
            }
        case 'renderer':
            return {
                durationContext: `Canvas / GPU 相关事件记录为 ${formattedDuration}；这里只能说明时间上相关，不能从 CPU 时间线确认 GPU 阻塞。`,
                nextStep:
                    '检查每帧 draw call、像素比、离屏缓冲区、纹理上传和临时对象分配；若怀疑 GPU，请再用浏览器或引擎的 GPU timing 验证。',
                sourceContext,
            }
        case 'resource':
            return {
                durationContext: `资源事件记录为 ${formattedDuration}，其中可能包含网络等待，不能当作同等时长的主线程阻塞。`,
                nextStep: '先确认资源是否延迟首帧或交互，再按需压缩、缓存、预加载或延迟加载；不要为不在关键路径上的资源提前优化。',
                sourceContext,
            }
        case 'animation':
            return {
                durationContext: `动画区间记录为 ${formattedDuration}；这可能只是设计时长，并不直接代表这段时间持续占用 CPU。`,
                nextStep: '检查区间内逐帧 Script、Layout、Paint 和慢帧分布；适合时优先使用 transform/opacity，但仍需结合视觉效果和实测。',
                sourceContext,
            }
        case 'interaction':
            return {
                durationContext: `交互区间记录为 ${formattedDuration}，可能同时包含输入等待、处理和呈现阶段，不能直接视为事件处理器 CPU 时间。`,
                nextStep: '分别检查输入延迟、处理器同步工作和下一次绘制，并在相邻慢帧或 Long Task 中寻找可验证的关联。',
                sourceContext,
            }
        case 'marker':
            return {
                durationContext: `该标记跨度为 ${formattedDuration}；标记通常描述区间边界，本身不表示性能成本。`,
                nextStep: '把它作为时间锚点，与同一窗口内的脚本、布局、绘制和帧事件对照，不要把标记名称当作根因。',
                sourceContext,
            }
        default:
            return {
                durationContext: `该事件记录为 ${formattedDuration}；持续时间可能包含等待、嵌套或重叠，不能直接解释为独占 CPU 成本。`,
                nextStep: '先在父子调用树和相邻时间窗口中确认它与慢帧或交互延迟是否重复相关，再决定具体修改。',
                sourceContext,
            }
    }
}

export function LabTimeline({
    events,
    durationMs,
    totalEvents,
    truncated,
}: {
    events: LabTimelineEvent[]
    durationMs: number
    totalEvents: number
    truncated: boolean
}) {
    const orderedEvents = useMemo(
        () => boundTimelineEvents([...events].sort((left, right) => left.startTimeMs - right.startTimeMs)),
        [events]
    )
    const lanes = useMemo(() => [...new Set(orderedEvents.map(eventLane))], [orderedEvents])
    const laneIndex = useMemo(() => new Map(lanes.map((lane, index) => [lane, index])), [lanes])
    const effectiveDuration = useMemo(() => {
        let maximum = Math.max(1, durationMs)
        for (const event of orderedEvents) maximum = Math.max(maximum, event.startTimeMs + Math.max(0, event.durationMs))
        return maximum
    }, [durationMs, orderedEvents])
    const canvasHeight = Math.min(440, Math.max(210, lanes.length * 34 + TOP_PADDING + BOTTOM_PADDING))
    const [selectedId, setSelectedId] = useState<string | null>(orderedEvents[0]?.eventId ?? null)
    const [canvasWidth, setCanvasWidth] = useState(720)
    const containerRef = useRef<HTMLDivElement>(null)
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const hitBoxesRef = useRef<EventHitBox[]>([])

    const selectedIndex = useMemo(() => orderedEvents.findIndex(event => event.eventId === selectedId), [orderedEvents, selectedId])
    const selectedEvent = selectedIndex >= 0 ? orderedEvents[selectedIndex] : null
    const recommendation = useMemo(() => (selectedEvent ? recommendForTimelineEvent(selectedEvent) : null), [selectedEvent])

    useEffect(() => {
        if (orderedEvents.length === 0) {
            setSelectedId(null)
            return
        }
        if (!orderedEvents.some(event => event.eventId === selectedId)) setSelectedId(orderedEvents[0].eventId)
    }, [orderedEvents, selectedId])

    useEffect(() => {
        const container = containerRef.current
        if (!container) return
        const updateWidth = () => setCanvasWidth(Math.max(360, Math.floor(container.clientWidth)))
        updateWidth()
        const observer = new ResizeObserver(updateWidth)
        observer.observe(container)
        return () => observer.disconnect()
    }, [])

    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas || orderedEvents.length === 0) return
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        canvas.width = Math.floor(canvasWidth * dpr)
        canvas.height = Math.floor(canvasHeight * dpr)
        canvas.style.width = `${canvasWidth}px`
        canvas.style.height = `${canvasHeight}px`

        const context = canvas.getContext('2d')
        if (!context) return
        context.setTransform(dpr, 0, 0, dpr, 0, 0)
        context.clearRect(0, 0, canvasWidth, canvasHeight)

        const plotWidth = Math.max(1, canvasWidth - LANE_LABEL_WIDTH - RIGHT_PADDING)
        const availableHeight = canvasHeight - TOP_PADDING - BOTTOM_PADDING
        const laneHeight = availableHeight / Math.max(1, lanes.length)
        const eventHeight = Math.max(4, Math.min(18, laneHeight - 8))

        context.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace'
        context.textBaseline = 'middle'
        context.strokeStyle = 'rgba(148, 163, 184, 0.25)'
        context.fillStyle = '#64748b'
        context.lineWidth = 1

        const tickCount = canvasWidth < 640 ? 4 : 8
        for (let tick = 0; tick <= tickCount; tick += 1) {
            const ratio = tick / tickCount
            const x = LANE_LABEL_WIDTH + plotWidth * ratio
            context.beginPath()
            context.moveTo(x + 0.5, TOP_PADDING - 8)
            context.lineTo(x + 0.5, canvasHeight - BOTTOM_PADDING)
            context.stroke()
            context.fillText(formatLabDuration(effectiveDuration * ratio), x + 3, 13)
        }

        lanes.forEach((lane, index) => {
            const y = TOP_PADDING + laneHeight * index
            context.fillStyle = '#64748b'
            context.fillText(lane.length > 17 ? `${lane.slice(0, 16)}…` : lane, 8, y + laneHeight / 2)
            context.beginPath()
            context.moveTo(LANE_LABEL_WIDTH, y + laneHeight)
            context.lineTo(canvasWidth - RIGHT_PADDING, y + laneHeight)
            context.stroke()
        })

        const hitBoxes: EventHitBox[] = []
        for (const event of orderedEvents) {
            const index = laneIndex.get(eventLane(event)) ?? 0
            const x = LANE_LABEL_WIDTH + (Math.max(0, event.startTimeMs) / effectiveDuration) * plotWidth
            const width = Math.max(2, (Math.max(0, event.durationMs) / effectiveDuration) * plotWidth)
            const y = TOP_PADDING + laneHeight * index + (laneHeight - eventHeight) / 2
            const boundedWidth = Math.max(1, Math.min(width, canvasWidth - RIGHT_PADDING - x))
            context.fillStyle = CATEGORY_COLORS[event.category]
            context.globalAlpha = event.eventId === selectedId ? 1 : event.severity === 'error' ? 0.95 : 0.75
            context.fillRect(x, y, boundedWidth, eventHeight)
            if (event.eventId === selectedId) {
                context.globalAlpha = 1
                context.strokeStyle = '#ffffff'
                context.lineWidth = 2
                context.strokeRect(x - 1, y - 1, boundedWidth + 2, eventHeight + 2)
                context.strokeStyle = 'rgba(148, 163, 184, 0.25)'
                context.lineWidth = 1
            }
            hitBoxes.push({ eventId: event.eventId, x, y: y - 3, width: Math.max(5, boundedWidth), height: eventHeight + 6 })
        }
        context.globalAlpha = 1
        hitBoxesRef.current = hitBoxes
    }, [canvasHeight, canvasWidth, effectiveDuration, laneIndex, lanes, orderedEvents, selectedId])

    const selectAtPointer = (clientX: number, clientY: number) => {
        const canvas = canvasRef.current
        if (!canvas) return
        const bounds = canvas.getBoundingClientRect()
        const x = clientX - bounds.left
        const y = clientY - bounds.top
        let nearest: EventHitBox | null = null
        let distance = Number.POSITIVE_INFINITY
        for (const box of hitBoxesRef.current) {
            if (y < box.y || y > box.y + box.height) continue
            const currentDistance = x < box.x ? box.x - x : x > box.x + box.width ? x - box.x - box.width : 0
            if (currentDistance < distance) {
                nearest = box
                distance = currentDistance
            }
        }
        if (nearest && distance <= 12) setSelectedId(nearest.eventId)
    }

    if (orderedEvents.length === 0) {
        return <div className="px-6 py-10 text-sm text-muted-foreground">这个视图没有可显示的时间线事件。</div>
    }

    return (
        <div className="grid min-w-0 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="min-w-0 border-b xl:border-r xl:border-b-0">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3 text-xs text-muted-foreground">
                    <span>
                        显示 {orderedEvents.length.toLocaleString()} / {totalEvents.toLocaleString()} 个事件
                        {truncated || events.length > orderedEvents.length ? '（已做有界采样）' : ''}
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                        <MousePointer2 className="h-3.5 w-3.5" aria-hidden="true" /> 点击事件，或聚焦后使用 ← / →
                    </span>
                </div>
                <div ref={containerRef} className="w-full overflow-x-auto bg-muted/10">
                    <canvas
                        ref={canvasRef}
                        className="block cursor-crosshair focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        tabIndex={0}
                        aria-label={`性能时间线，共 ${orderedEvents.length} 个有界事件。使用左右方向键选择事件。`}
                        onClick={event => selectAtPointer(event.clientX, event.clientY)}
                        onKeyDown={event => {
                            if (!orderedEvents.length) return
                            let nextIndex = selectedIndex < 0 ? 0 : selectedIndex
                            if (event.key === 'ArrowRight') nextIndex = Math.min(orderedEvents.length - 1, nextIndex + 1)
                            else if (event.key === 'ArrowLeft') nextIndex = Math.max(0, nextIndex - 1)
                            else if (event.key === 'Home') nextIndex = 0
                            else if (event.key === 'End') nextIndex = orderedEvents.length - 1
                            else return
                            event.preventDefault()
                            setSelectedId(orderedEvents[nextIndex].eventId)
                        }}
                    />
                </div>
            </div>

            <aside className="min-w-0 p-5" aria-live="polite">
                {selectedEvent ? (
                    <div className="grid gap-5">
                        <div>
                            <div className="flex flex-wrap items-center gap-2">
                                <Badge style={{ backgroundColor: CATEGORY_COLORS[selectedEvent.category], color: '#fff' }}>
                                    {CATEGORY_LABELS[selectedEvent.category]}
                                </Badge>
                                {selectedEvent.severity === 'warning' || selectedEvent.severity === 'error' ? (
                                    <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                                        <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                                        {selectedEvent.severity === 'error' ? '严重' : '警告'}
                                    </span>
                                ) : null}
                            </div>
                            <h3 className="mt-3 break-words text-base font-semibold">{selectedEvent.name}</h3>
                            {selectedEvent.description ? (
                                <p className="mt-1 text-sm text-muted-foreground">{selectedEvent.description}</p>
                            ) : null}
                        </div>

                        <dl className="grid grid-cols-2 gap-3 text-sm">
                            <div>
                                <dt className="text-xs text-muted-foreground">开始</dt>
                                <dd className="mt-1 font-mono tabular-nums">{formatLabDuration(selectedEvent.startTimeMs)}</dd>
                            </div>
                            <div>
                                <dt className="text-xs text-muted-foreground">持续</dt>
                                <dd className="mt-1 font-mono tabular-nums">{formatLabDuration(selectedEvent.durationMs)}</dd>
                            </div>
                            <div className="col-span-2">
                                <dt className="text-xs text-muted-foreground">轨道</dt>
                                <dd className="mt-1 break-words">{eventLane(selectedEvent)}</dd>
                            </div>
                        </dl>

                        {recommendation ? (
                            <section
                                className="rounded-lg border border-sky-500/20 bg-sky-500/5 p-4"
                                aria-labelledby="timeline-advice-title"
                            >
                                <h4 id="timeline-advice-title" className="inline-flex items-center gap-2 text-sm font-medium">
                                    <Lightbulb className="h-4 w-4 text-sky-600 dark:text-sky-400" aria-hidden="true" />
                                    基于当前事件的排查建议
                                </h4>
                                <div className="mt-3 grid gap-2 text-xs leading-5 text-muted-foreground">
                                    <p>{recommendation.durationContext}</p>
                                    <p>{recommendation.nextStep}</p>
                                    <p>{recommendation.sourceContext}</p>
                                </div>
                                <p className="mt-3 text-xs font-medium text-foreground">这是排查优先级，不是自动确认的根因。</p>
                            </section>
                        ) : null}

                        {selectedEvent.attributes && Object.keys(selectedEvent.attributes).length ? (
                            <div>
                                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">属性</h4>
                                <dl className="mt-2 grid gap-2 rounded-md border bg-muted/20 p-3 text-xs">
                                    {Object.entries(selectedEvent.attributes)
                                        .slice(0, 100)
                                        .map(([name, value]) => (
                                            <div key={name} className="grid grid-cols-[minmax(5rem,0.7fr)_minmax(0,1.3fr)] gap-2">
                                                <dt className="break-all text-muted-foreground">{name}</dt>
                                                <dd className="break-all font-mono text-right">{value == null ? 'null' : String(value)}</dd>
                                            </div>
                                        ))}
                                </dl>
                            </div>
                        ) : null}

                        <div>
                            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">调用堆栈</h4>
                            {selectedEvent.stack?.length ? (
                                <ol className="mt-2 max-h-64 overflow-auto rounded-md border bg-muted/20 p-3 font-mono text-[11px] leading-5">
                                    {selectedEvent.stack.slice(0, 100).map((frame, index) => (
                                        <li key={`${index}:${frame.fileName ?? ''}:${frame.lineNumber ?? ''}`} className="break-all">
                                            <span className="mr-2 text-muted-foreground">{index + 1}.</span>
                                            {formatStackFrame(frame)}
                                        </li>
                                    ))}
                                </ol>
                            ) : (
                                <p className="mt-2 text-sm text-muted-foreground">该事件没有可用堆栈。</p>
                            )}
                        </div>
                    </div>
                ) : (
                    <p className="text-sm text-muted-foreground">选择一个时间线事件查看详情。</p>
                )}
            </aside>
        </div>
    )
}
