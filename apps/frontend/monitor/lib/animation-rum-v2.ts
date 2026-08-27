import type {
    AnimationRumV2CapabilityName,
    AnimationRumV2CapabilityState,
    AnimationRumV2Family,
    AnimationRumV2JsonInteger,
    AnimationRumV2MetricStatus,
    AnimationRumV2MetricUnit,
    AnimationRumV2ProviderOwner,
    AnimationRumV2QualityReason,
    AnimationRumV2Relation,
    AnimationRumV2Scope,
    AnimationRumV2SummaryMetric,
} from '../types/animation-v2'

const DECIMAL_INTEGER = /^\d+$/

const FAMILY_LABELS: Record<AnimationRumV2Family, string> = {
    userOutcome: '用户结果',
    frameCadence: '帧节奏',
    mainThread: '主线程',
    renderingPipeline: '渲染流水线',
    renderer: '渲染器 / Canvas',
    scrollGesture: '滚动 / 手势',
    resourcesMedia: '资源 / 媒体',
    memoryLifecycle: '内存 / 生命周期',
    workAvoidance: '无效工作规避',
    accessibility: '无障碍',
    motionQuality: '动效质量',
    monitorOverhead: '监控自身开销',
}

const QUALITY_REASON_LABELS: Record<AnimationRumV2QualityReason, string> = {
    'adapter-error': '适配器发生错误',
    'insufficient-frame-samples': '帧样本不足',
    'provider-rejected-samples': '数据提供方拒绝了样本',
    'provider-truncated': '数据提供方样本被截断',
    'refresh-confidence-low': '刷新率置信度较低',
    'source-field-incomplete': '源字段不完整',
    'visible-window-too-short': '页面可见测量窗口过短',
    'window-capped': '测量窗口达到上限',
}

const CAPABILITY_LABELS: Record<AnimationRumV2CapabilityName, string> = {
    'long-animation-frame': '长动画帧（LoAF）',
    longtask: '长任务（Long Task）',
    'event-timing': '交互事件时序',
    'resource-timing': '资源时序',
    'resource-timing-buffer-events': '资源缓冲区事件',
    'web-vitals': 'Web Vitals',
    'web-vitals-attribution': 'Web Vitals 归因',
    'web-vitals-soft-navigation': '软导航 Web Vitals',
    'reduced-motion-preference': '减少动态效果偏好',
    'document-animations-inspection': '文档动画检查',
    'visibility-lifecycle': '页面可见性生命周期',
    'loaf-paint-time': 'LoAF 绘制时间',
    'loaf-presentation-time': 'LoAF 呈现时间',
    'input-frame-scheduling': '输入到帧调度',
    'page-evidence': '页面级证据',
    'canvas-context-registry': 'Canvas 上下文登记',
    'video-frame-callback': '视频帧回调',
    'video-playback-quality': '视频播放质量',
    'framework-adapter': '框架适配器',
    'renderer-adapter': '渲染器适配器',
    'media-adapter': '媒体适配器',
    'target-direct-inspection': '目标元素直接检查',
    'interaction-quality-adapter': '交互质量适配器',
    'gpu-timer-query': 'GPU 计时查询',
}

const OWNER_LABELS: Record<AnimationRumV2ProviderOwner, string> = {
    'browser-core': '浏览器核心探针',
    'web-vitals-runtime': 'Web Vitals 运行时',
    'resource-timing': '资源时序探针',
    'browser-page-evidence': '页面证据探针',
    'input-scheduling': '输入调度探针',
    'media-adapter': '媒体适配器',
    'renderer-adapter': '渲染器适配器',
    'target-sidecar': '目标元素侧车',
}

export function formatAnimationRumV2Integer(value: AnimationRumV2JsonInteger): string {
    if (value === null) return '—'
    if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('zh-CN') : '—'
    if (!DECIMAL_INTEGER.test(value)) return '—'
    return value.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export function isPositiveAnimationRumV2Integer(value: AnimationRumV2JsonInteger): boolean {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0
    return typeof value === 'string' && DECIMAL_INTEGER.test(value) && /[1-9]/.test(value)
}

export function decodeAnimationRumV2CaptureId(value: string): string | null {
    try {
        const decoded = decodeURIComponent(value)
        return decoded.length > 0 ? decoded : null
    } catch {
        return null
    }
}

export function formatAnimationRumV2Metric(value: number | null | undefined, unit: AnimationRumV2MetricUnit): string {
    if (value === null || value === undefined || !Number.isFinite(value)) return '未采集 / 未知'
    const format = (maximumFractionDigits: number) => value.toLocaleString('zh-CN', { maximumFractionDigits })
    if (unit === 'ratio') return `${(value * 100).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%`
    if (unit === 'percent') return `${format(1)}%`
    if (unit === 'ms') return `${format(1)} ms`
    if (unit === 'bytes') {
        if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} MiB`
        if (value >= 1024) return `${(value / 1024).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} KiB`
        return `${format(0)} B`
    }
    if (unit === 'hz') return `${format(1)} Hz`
    if (unit === 'pixels') return `${format(0)} px`
    if (unit === 'frames') return `${format(1)} 帧`
    if (unit === 'multiplier') return `${format(2)}×`
    return format(unit === 'count' ? 0 : 2)
}

export function animationRumV2StatusLabel(status: AnimationRumV2MetricStatus): string {
    switch (status) {
        case 'measured':
            return '已测量'
        case 'partial':
            return '部分测量'
        case 'not-observed':
            return '未观测到'
        case 'not-instrumented':
            return '未接入采集'
        case 'unsupported':
            return '当前环境不支持'
        case 'unknown':
            return '未知'
    }
}

export function animationRumV2StatusVariant(status: AnimationRumV2MetricStatus) {
    if (status === 'measured') return 'success' as const
    if (status === 'partial' || status === 'not-observed') return 'warning' as const
    return 'outline' as const
}

export function animationRumV2CapabilityStateLabel(state: AnimationRumV2CapabilityState): string {
    switch (state) {
        case 'supported':
            return '支持'
        case 'unsupported':
            return '不支持'
        case 'disabled':
            return '已关闭'
        case 'unknown':
            return '未知'
    }
}

export function animationRumV2CapabilityVariant(state: AnimationRumV2CapabilityState) {
    if (state === 'supported') return 'success' as const
    if (state === 'disabled') return 'warning' as const
    return 'outline' as const
}

export function animationRumV2FamilyLabel(family: AnimationRumV2Family): string {
    return FAMILY_LABELS[family]
}

export function animationRumV2QualityReasonLabel(reason: AnimationRumV2QualityReason): string {
    return QUALITY_REASON_LABELS[reason]
}

export function animationRumV2CapabilityLabel(capability: AnimationRumV2CapabilityName): string {
    return CAPABILITY_LABELS[capability]
}

export function animationRumV2OwnerLabel(owner: AnimationRumV2ProviderOwner): string {
    return OWNER_LABELS[owner]
}

export function animationRumV2ScopeLabel(scope: AnimationRumV2Scope): string {
    return scope === 'page' ? '页面级' : '目标级'
}

export function animationRumV2RelationLabel(relation: AnimationRumV2Relation): string {
    switch (relation) {
        case 'page-window':
            return '页面窗口直接证据'
        case 'target-direct':
            return '目标直接证据'
        case 'target-temporal-overlap':
            return '目标时间窗口重叠（非因果证明）'
        case 'adapter':
            return '适配器证据'
    }
}

export function findAnimationRumV2SummaryMetric(
    metrics: readonly AnimationRumV2SummaryMetric[],
    metricId: string,
    scope: AnimationRumV2Scope,
    relation?: AnimationRumV2Relation
): AnimationRumV2SummaryMetric | undefined {
    return metrics.find(metric => metric.metricId === metricId && metric.scope === scope && (!relation || metric.relation === relation))
}

export function animationRumV2MetricDisplay(metric: AnimationRumV2SummaryMetric): {
    normalized: boolean
    p50: number | null
    p75: number | null
    p95: number | null
} {
    if (metric.valuePerMinute) {
        return {
            normalized: true,
            p50: metric.valuePerMinute.p50,
            p75: metric.valuePerMinute.p75,
            p95: metric.valuePerMinute.p95,
        }
    }
    return {
        normalized: false,
        p50: metric.captureValue.p50,
        p75: metric.captureValue.p75,
        p95: metric.captureValue.p95,
    }
}
