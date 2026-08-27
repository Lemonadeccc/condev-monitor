import { formatLabBytes, formatLabDuration, formatLabScore } from '@/lib/lab'
import type { LabBudgetRuleRef, LabMetric, LabRun, LabRunAnalysis } from '@/types/lab'

export type LabBilingualLabel = Readonly<{
    zhCN: string
    en: string
}>

const UNKNOWN: LabBilingualLabel = { zhCN: '未采集 / 未知', en: 'Not collected / unknown' }

const METRIC_LABELS: Readonly<Record<string, LabBilingualLabel>> = {
    'frame.refresh.inferred': {
        zhCN: '页面 rAF 回调节奏（帧间隔 p50 推算）',
        en: 'Observed page rAF callback cadence (from frame-interval p50)',
    },
    'pipeline.loaf-render-start-to-paint.count': {
        zhCN: 'LoAF 渲染开始 → Paint 有效样本数',
        en: 'LoAF render start → paint valid samples',
    },
    'pipeline.loaf-render-start-to-paint.p95': {
        zhCN: 'LoAF 渲染开始 → Paint p95',
        en: 'LoAF render start → paint p95',
    },
    'pipeline.loaf-paint-to-presentation.count': {
        zhCN: 'LoAF Paint → Presentation 有效样本数',
        en: 'LoAF paint → presentation valid samples',
    },
    'pipeline.loaf-paint-to-presentation.p95': {
        zhCN: 'LoAF Paint → Presentation p95',
        en: 'LoAF paint → presentation p95',
    },
    'main.input-capture-to-next-raf-callback.count': {
        zhCN: '输入捕获 → 下一次 rAF 回调有效样本数',
        en: 'Input capture → next rAF callback valid samples',
    },
    'main.input-capture-to-next-raf-callback.p95': {
        zhCN: '输入捕获 → 下一次 rAF 回调 p95',
        en: 'Input capture → next rAF callback p95',
    },
    'interaction.loaf-first-ui-event-to-frame-end.count': {
        zhCN: 'LoAF 首个 UI 事件 → 帧结束有效样本数',
        en: 'LoAF first UI event → frame end valid samples',
    },
    'interaction.loaf-first-ui-event-to-frame-end.p95': {
        zhCN: 'LoAF 首个 UI 事件 → 帧结束 p95',
        en: 'LoAF first UI event → frame end p95',
    },
    'pipeline.loaf-attributed-forced-style-layout.count': {
        zhCN: 'LoAF 归因的强制样式 / 布局有效帧样本数',
        en: 'LoAF-attributed forced style / layout valid frame samples',
    },
    'pipeline.loaf-attributed-forced-style-layout.p95': {
        zhCN: 'LoAF 归因的强制样式 / 布局耗时 p95',
        en: 'LoAF-attributed forced style / layout duration p95',
    },
}

const STATUS_LABELS: Readonly<Record<string, LabBilingualLabel>> = {
    measured: { zhCN: '已测量', en: 'Measured' },
    partial: { zhCN: '部分测量', en: 'Partial' },
    'not-observed': { zhCN: '未观测到有效值', en: 'Not observed' },
    unsupported: { zhCN: '当前能力不支持', en: 'Unsupported' },
    unknown: { zhCN: '能力或证据未知', en: 'Unknown' },
}

const POPULATION_LABELS: Readonly<Record<string, LabBilingualLabel>> = {
    frames: { zhCN: '帧', en: 'Frames' },
    events: { zhCN: '事件', en: 'Events' },
    tasks: { zhCN: '任务', en: 'Tasks' },
    attempts: { zhCN: '重复尝试', en: 'Attempts' },
    actions: { zhCN: '动作', en: 'Actions' },
    resources: { zhCN: '资源', en: 'Resources' },
    surfaces: { zhCN: '渲染表面', en: 'Surfaces' },
    animations: { zhCN: '动画', en: 'Animations' },
    'media-frames': { zhCN: '媒体帧', en: 'Media frames' },
    bytes: { zhCN: '字节', en: 'Bytes' },
    samples: { zhCN: '样本', en: 'Samples' },
    latest: { zhCN: '最新观测', en: 'Latest observation' },
}

const METHOD_LABELS: Readonly<Record<string, LabBilingualLabel>> = {
    latest: { zhCN: '最新值', en: 'Latest' },
    count: { zhCN: '计数', en: 'Count' },
    sum: { zhCN: '总和', en: 'Sum' },
    ratio: { zhCN: '比率', en: 'Ratio' },
    'nearest-rank': { zhCN: '最近秩百分位', en: 'Nearest-rank percentile' },
    'median-of-attempts': { zhCN: '多次尝试中位数', en: 'Median of attempts' },
    'arithmetic-mean': { zhCN: '算术平均值', en: 'Arithmetic mean' },
    min: { zhCN: '最小值', en: 'Minimum' },
    max: { zhCN: '最大值', en: 'Maximum' },
}

const LIMITATION_LABELS: Readonly<Record<string, LabBilingualLabel>> = {
    'observed-page-raf-cadence-not-display-refresh-rate': {
        zhCN: '该值由页面可见 rAF 帧间隔 p50 推算，不是物理屏幕刷新率、合成器呈现 FPS 或 GPU FPS。',
        en: 'Derived from the visible page rAF frame-interval p50; it is not the physical display refresh rate, compositor presentation FPS, or GPU FPS.',
    },
    'event-timing-duration-threshold-16ms': {
        zhCN: 'Event Timing 只包含浏览器按 16 ms duration threshold 暴露的条目，不代表全部输入事件。',
        en: 'Event Timing includes only entries exposed under the 16 ms duration threshold; it does not represent every input event.',
    },
    'event-timing-entry-count-not-distinct-interactions': {
        zhCN: '该计数是 PerformanceEventTiming 条目数，未按 interactionId 去重，不等于独立交互次数。',
        en: 'This is a count of PerformanceEventTiming entries, not distinct interactions deduplicated by interactionId.',
    },
    'loaf-only-over-50ms': {
        zhCN: '仅覆盖超过 50 ms 的 LoAF，不代表全部帧。',
        en: 'Covers LoAF entries over 50 ms only, not every frame.',
    },
    'presentation-time-implementation-dependent': {
        zhCN: 'Presentation 时间由浏览器实现决定，可能不可用。',
        en: 'Presentation timing is implementation-dependent and may be unavailable.',
    },
    'input-capture-listener-to-next-raf-callback-proxy': {
        zhCN: '测量边界是输入捕获监听器入口到下一次共享 rAF 回调入口，只是主线程调度代理值。',
        en: 'The boundary runs from capture-listener entry to the next shared rAF callback entry; it is a main-thread scheduling proxy.',
    },
    'not-paint-or-presentation-timing': {
        zhCN: '这个代理值不是 Paint、Presentation 或视觉完成时间。',
        en: 'This proxy is not paint, presentation, or visual-completion timing.',
    },
    'trusted-discrete-input-only': {
        zhCN: '只采集受信任的离散输入；连续 pointermove 和 scroll 不属于该指标。',
        en: 'Only trusted discrete input is sampled; continuous pointermove and scroll are outside this metric.',
    },
    'loaf-frame-end-not-paint-or-presentation': {
        zhCN: 'LoAF 条目结束边界不是 Paint 或 Presentation 时间。',
        en: 'The LoAF entry end boundary is not paint or presentation timing.',
    },
    'first-ui-event-may-predate-loaf': {
        zhCN: 'firstUIEventTimestamp 可能早于 LoAF 条目的开始时间。',
        en: 'firstUIEventTimestamp may precede the start of the LoAF entry.',
    },
    'loaf-attributed-scripts-lower-bound': {
        zhCN: '只汇总浏览器暴露的 LoAF script 归因，结果是归因耗时的下界。',
        en: 'Only browser-exposed LoAF script attribution is summed, so the result is a lower bound on attributed time.',
    },
    'forced-style-layout-implementation-dependent': {
        zhCN: 'forcedStyleAndLayoutDuration 字段由浏览器实现决定，可能不可用或不完整。',
        en: 'The forcedStyleAndLayoutDuration field is implementation-dependent and may be unavailable or incomplete.',
    },
    'loaf-render-paint-boundary-candidates-incomplete': {
        zhCN: '部分候选 LoAF 缺少有效的 Render start → Paint 边界；聚合只包含完整样本。',
        en: 'Some candidate LoAF entries lacked a valid render start → paint boundary; the aggregate includes complete samples only.',
    },
    'loaf-paint-presentation-boundary-candidates-incomplete': {
        zhCN: '部分候选 LoAF 缺少有效的 Paint → Presentation 边界；聚合只包含完整样本。',
        en: 'Some candidate LoAF entries lacked a valid paint → presentation boundary; the aggregate includes complete samples only.',
    },
    'input-frame-scheduling-candidates-incomplete': {
        zhCN: '部分输入候选没有形成完整的“捕获 → 下一次 rAF 回调”样本；聚合未覆盖全部候选。',
        en: 'Some input candidates did not complete a capture → next rAF callback sample; the aggregate does not cover every candidate.',
    },
    'loaf-first-ui-event-candidates-incomplete': {
        zhCN: '部分 LoAF UI 事件候选无法形成有效的“首个 UI 事件 → 帧结束”样本。',
        en: 'Some LoAF UI-event candidates could not produce a valid first UI event → frame end sample.',
    },
    'loaf-forced-style-layout-attribution-incomplete': {
        zhCN: '部分 LoAF 候选缺少完整有效的 script 强制样式 / 布局归因；不会用截断前缀伪造总和。',
        en: 'Some LoAF candidates lacked complete valid script attribution for forced style / layout; no truncated prefix sum is reported.',
    },
    'page-probe-frame-samples-truncated': {
        zhCN: '帧样本缓冲已截断，分布属于部分证据。',
        en: 'The frame sample buffer was truncated; the distribution is partial evidence.',
    },
    'page-probe-long-task-samples-truncated': {
        zhCN: 'Long Task 样本缓冲已截断。',
        en: 'The Long Task sample buffer was truncated.',
    },
    'page-probe-loaf-samples-truncated': {
        zhCN: 'LoAF 样本缓冲已截断，尾部分布可能不完整。',
        en: 'The LoAF sample buffer was truncated; the tail distribution may be incomplete.',
    },
    'page-probe-event-timing-samples-truncated': {
        zhCN: 'Event Timing 样本缓冲已截断。',
        en: 'The Event Timing sample buffer was truncated.',
    },
    'page-probe-resource-timing-samples-truncated': {
        zhCN: 'Resource Timing 样本缓冲已截断。',
        en: 'The Resource Timing sample buffer was truncated.',
    },
    'page-probe-input-frame-scheduling-samples-truncated': {
        zhCN: '输入帧调度样本缓冲已截断；保留的耗时分布和动作归属可能不完整。',
        en: 'The input-frame scheduling buffer was truncated; retained duration distribution and action attribution may be incomplete.',
    },
    'page-probe-samples-truncated': {
        zhCN: '页面探针至少一个样本流已截断。',
        en: 'At least one page-probe sample stream was truncated.',
    },
    'partial-attempt-coverage': {
        zhCN: '只有部分重复尝试提供了该证据。',
        en: 'Only some measured attempts provided this evidence.',
    },
    'cross-document-sampling-partial': {
        zhCN: '跨文档导航使采样窗口不连续，结果为部分证据。',
        en: 'Cross-document navigation interrupted the sampling window; evidence is partial.',
    },
    'canonical-action-metrics-truncated': {
        zhCN: '动作级 canonical 指标投影已截断。',
        en: 'The canonical action-metric projection was truncated.',
    },
    'canonical-metric-projection-truncated': {
        zhCN: 'Canonical 指标投影已截断。',
        en: 'The canonical metric projection was truncated.',
    },
    'attempt-metric-projection-truncated': {
        zhCN: '单次尝试的指标投影已截断。',
        en: 'The per-attempt metric projection was truncated.',
    },
    'report-upload-byte-budget-truncated-attempt-detail': {
        zhCN: '上传字节预算裁剪了单次尝试明细。',
        en: 'The upload byte budget truncated per-attempt detail.',
    },
    'warmup-detail-omitted-from-report': {
        zhCN: '热身运行明细按合同未写入报告。',
        en: 'Warm-up detail was intentionally omitted from the report.',
    },
    'diagnostic-project-budget-not-web-standard': {
        zhCN: '这是项目诊断预算，不是 Web 标准阈值。',
        en: 'This is a project diagnostic budget, not a Web-standard threshold.',
    },
    'renderer-gpu-timing-requires-explicit-evidence': {
        zhCN: '渲染器 / GPU 耗时需要显式 adapter 或计时器证据；DOM 页面探针不能推断。',
        en: 'Renderer / GPU timing requires explicit adapter or timer evidence; the DOM page probe cannot infer it.',
    },
    'continuous-input-observation-is-sampled': {
        zhCN: '连续输入采用采样观测，不代表每个 pointermove 或 scroll 事件。',
        en: 'Continuous input is sampled and does not represent every pointermove or scroll event.',
    },
    'canvas-context-observation-starts-at-probe-install': {
        zhCN: 'Canvas context 观测从页面探针安装后开始，无法恢复更早创建的 context。',
        en: 'Canvas-context observation starts when the page probe is installed and cannot recover contexts created earlier.',
    },
    'browser-outcomes-do-not-prove-framework-owner': {
        zhCN: '浏览器结果不能证明由哪个框架组件或渲染器对象造成。',
        en: 'Browser outcomes do not prove which framework component or renderer object owns the cost.',
    },
    'clock-measures-runner-action-window-not-renderer-work': {
        zhCN: 'Runner 时钟测量的是动作窗口，不是渲染器实际工作耗时。',
        en: 'The Runner clock measures the action window, not actual renderer work.',
    },
    'trace-category-durations-may-overlap': {
        zhCN: 'Trace 分类耗时可能互相重叠，不能相加当作独占 CPU 时间。',
        en: 'Trace category durations may overlap and must not be summed as exclusive CPU time.',
    },
    'separate-navigation-experiment': {
        zhCN: 'Lighthouse 属于独立导航实验，不等同于场景动作的持续测量。',
        en: 'Lighthouse is a separate navigation experiment, not a sustained measurement of scenario actions.',
    },
    'surface-observation-does-not-prove-renderer-cost': {
        zhCN: '观察到渲染表面只能证明其存在，不能证明渲染器成本或根因。',
        en: 'Observing a rendering surface proves its presence, not renderer cost or root cause.',
    },
    'declared-technology-is-not-runtime-owner-proof': {
        zhCN: 'Scenario 中声明的技术栈不是运行时归属或成本证据。',
        en: 'A technology declared in the Scenario is not runtime ownership or cost evidence.',
    },
    'declared-subject-is-not-runtime-owner-proof': {
        zhCN: 'Scenario 中声明的目标不是运行时归属或成本证据。',
        en: 'A subject declared in the Scenario is not runtime ownership or cost evidence.',
    },
    'technology-evidence-projection-truncated': {
        zhCN: '技术证据投影已截断，报告没有保留全部候选。',
        en: 'The technology-evidence projection was truncated; not every candidate was retained.',
    },
    'cross-document-measurement-partial': {
        zhCN: '动作发生跨文档导航，动作窗口测量只保留了部分证据。',
        en: 'The action crossed documents, so its action-window measurement retains partial evidence only.',
    },
    'page-probe-reset-after-cross-document-navigation': {
        zhCN: '跨文档导航会重置页面探针；导航前后的样本不能组成连续窗口。',
        en: 'Cross-document navigation resets the page probe; pre- and post-navigation samples do not form one continuous window.',
    },
    'page-errors-observed': {
        zhCN: '测量期间观察到页面错误；需要结合错误明细判断结果可信度。',
        en: 'Page errors were observed during measurement; inspect the errors before trusting the result.',
    },
    'legacy-action-label-only': {
        zhCN: '旧报告只保留动作标签；时间关联不能替代明确的 actionId。',
        en: 'The legacy report retained an action label only; temporal association cannot replace an explicit actionId.',
    },
}

function humanize(value: string): string {
    return value
        .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
        .replace(/[._/-]+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim()
}

function fallbackLabel(value: string | null | undefined, prefix: string): LabBilingualLabel {
    const raw = value?.trim()
    if (!raw) return UNKNOWN
    return { zhCN: `${prefix}：${raw}`, en: humanize(raw) || raw }
}

export function getLabMetricLabel(metric: Pick<LabMetric, 'metricId' | 'name'>): LabBilingualLabel {
    if (metric.metricId && METRIC_LABELS[metric.metricId]) return METRIC_LABELS[metric.metricId]
    if (!metric.metricId && metric.name === 'inferredRefreshHz') return METRIC_LABELS['frame.refresh.inferred']
    return fallbackLabel(metric.name || metric.metricId, '指标')
}

export function getLabMetricStatusLabel(status: string | null | undefined): LabBilingualLabel {
    if (status && STATUS_LABELS[status]) return STATUS_LABELS[status]
    return fallbackLabel(status, '未知状态')
}

export function getLabMetricAggregationLabel(aggregation: LabMetric['aggregation']): LabBilingualLabel {
    if (!aggregation) return { zhCN: '未采集聚合方式', en: 'Aggregation unavailable' }
    const population = POPULATION_LABELS[aggregation.population] ?? fallbackLabel(aggregation.population, '总体')
    const method = METHOD_LABELS[aggregation.method] ?? fallbackLabel(aggregation.method, '方法')
    return {
        zhCN: `${population.zhCN} · ${method.zhCN}`,
        en: `${population.en} · ${method.en}`,
    }
}

export function getLabLimitationLabel(code: string): LabBilingualLabel {
    const known = LIMITATION_LABELS[code]
    if (known) return known
    const eligibleAttempts = /^eligible-attempts-(\d+)$/u.exec(code)
    if (eligibleAttempts) {
        return {
            zhCN: `${eligibleAttempts[1]} 次尝试包含有效值。`,
            en: `${eligibleAttempts[1]} attempts contained a valid value.`,
        }
    }
    const totalAttempts = /^total-attempts-(\d+)$/u.exec(code)
    if (totalAttempts) {
        return {
            zhCN: `本次聚合包含 ${totalAttempts[1]} 次测量尝试。`,
            en: `This aggregate covered ${totalAttempts[1]} measured attempts.`,
        }
    }
    return fallbackLabel(code, '限制代码')
}

function formatNumber(value: number): string {
    if (Number.isInteger(value)) return value.toLocaleString()
    return value.toLocaleString(undefined, { maximumFractionDigits: 3 })
}

const LIGHTHOUSE_CATEGORY_SCORE_METRIC_IDS = new Set([
    'lighthouse.performance.score',
    'lighthouse.accessibility.score',
    'lighthouse.best-practices.score',
    'lighthouse.seo.score',
])

export function formatLabMetricValue(value: number | null | undefined, unit: string | null | undefined, metricId?: string | null): string {
    if (value == null || !Number.isFinite(value)) return UNKNOWN.zhCN
    switch (unit) {
        case 'ms':
            return value < 100 ? `${value.toFixed(value < 10 ? 2 : 1)} ms` : formatLabDuration(value)
        case 'bytes':
            return formatLabBytes(value)
        case 'score':
            return metricId && LIGHTHOUSE_CATEGORY_SCORE_METRIC_IDS.has(metricId) ? formatLabScore(value) : formatNumber(value)
        case 'percent':
            return `${formatNumber(value)}%`
        case 'ratio':
            return `${formatNumber(value * 100)}%`
        case 'hz':
            return `${formatNumber(value)} Hz`
        case 'count':
            return `${formatNumber(value)} 次`
        case 'frames':
            return `${formatNumber(value)} 帧`
        default:
            return `${formatNumber(value)}${unit ? ` ${unit}` : ''}`
    }
}

export function labBudgetRefLabel(ref: LabBudgetRuleRef | LabRunAnalysis['measurementContract']['budgetRef']): string {
    const rule = 'ruleId' in ref ? ` / ${ref.ruleId}` : ''
    return `catalog v${ref.catalogVersion} · ${ref.budgetId}@${ref.budgetVersion}${rule}`
}

function metricIdentity(metric: LabMetric): string {
    return [
        metric.metricId || `${metric.family}:${metric.name}:${metric.stat}:${metric.unit}`,
        metric.scope?.level || 'legacy',
        metric.scope?.attemptId || '',
        metric.scope?.actionId || '',
        metric.scope?.subjectKey || '',
    ].join('|')
}

/** Keeps run evidence separate from action/subject attribution. */
export function selectLabRunMetrics(run: LabRun, analysis: LabRunAnalysis | null | undefined): LabMetric[] {
    const structured = analysis?.semanticsVersion === 2 && Array.isArray(analysis.metrics)
    const source = structured ? analysis.metrics : Array.isArray(run.summary?.metrics) ? run.summary.metrics : []
    const seen = new Set<string>()
    const output: LabMetric[] = []
    source.slice(0, 256).forEach(metric => {
        const isRunMetric = metric.scope?.level === 'run' || (!structured && metric.scope === undefined)
        if (!isRunMetric) return
        const identity = metricIdentity(metric)
        if (seen.has(identity)) return
        seen.add(identity)
        output.push(metric)
    })
    return output
}
