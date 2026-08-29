import { formatDateTime } from '@/lib/datetime'
import { formatLabMetricValue, getLabMetricLabel, type LabBilingualLabel } from '@/lib/lab-metrics'
import type {
    LabComparisonCaveat,
    LabComparisonDistribution,
    LabComparisonExcludedMetric,
    LabComparisonExclusionReason,
    LabComparisonMetric,
    LabComparisonReasonField,
    LabComparisonRejectionReason,
    LabRun,
} from '@/types/lab'

const LAB_RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

const SIDE_LABELS = {
    before: { zhCN: '基线运行', en: 'Before run' },
    after: { zhCN: '变更后运行', en: 'After run' },
    both: { zhCN: '两次运行', en: 'Both runs' },
} as const satisfies Record<LabComparisonRejectionReason['side'], LabBilingualLabel>

export const LAB_COMPARISON_FIELD_LABELS = {
    candidate: { zhCN: '候选数据结构', en: 'candidate evidence structure' },
    'run-status': { zhCN: '运行完成状态', en: 'completed run status' },
    'measured-attempts': { zhCN: '测量尝试次数或完整性', en: 'measured-attempt count or integrity' },
    metrics: { zhCN: '指标结构或目录元组', en: 'metric structure or catalog tuple' },
    capabilities: { zhCN: '浏览器能力签名', en: 'browser capability signature' },
    'app-id': { zhCN: '所属应用', en: 'application' },
    'scenario-key': { zhCN: '场景标识', en: 'scenario key' },
    'route-key': { zhCN: '脱敏路由标识', en: 'privacy-safe route key' },
    'scenario-protocol': { zhCN: '场景协议摘要', en: 'scenario protocol digest' },
    environment: { zhCN: '环境', en: 'environment' },
    'browser-name': { zhCN: '浏览器引擎', en: 'browser engine' },
    'browser-version': { zhCN: '浏览器版本', en: 'browser version' },
    'browser-headless': { zhCN: '无头模式', en: 'headless mode' },
    'viewport-width': { zhCN: '视口宽度', en: 'viewport width' },
    'viewport-height': { zhCN: '视口高度', en: 'viewport height' },
    'device-scale-factor': { zhCN: '设备像素比', en: 'device scale factor' },
    'reduced-motion': { zhCN: '减少动态效果偏好', en: 'reduced-motion preference' },
    'cache-mode': { zhCN: '缓存模式', en: 'cache mode' },
    'warmup-runs': { zhCN: '热身次数', en: 'warm-up run count' },
    'measured-runs': { zhCN: '正式测量次数', en: 'measured run count' },
    'observation-duration': { zhCN: '观测时长', en: 'observation duration' },
    'trace-mode': { zhCN: 'Trace 开关', en: 'Trace mode' },
    'lighthouse-mode': { zhCN: 'Lighthouse 开关', en: 'Lighthouse mode' },
    'color-scheme': { zhCN: '颜色模式', en: 'color scheme' },
    'cpu-throttle-rate': { zhCN: 'CPU 节流倍率', en: 'CPU throttle rate' },
    'network-profile': { zhCN: '网络配置', en: 'network profile' },
    'execution-target': { zhCN: '执行目标类型', en: 'execution target' },
    'execution-driver': { zhCN: '执行驱动', en: 'execution driver' },
    'authenticated-context': { zhCN: '认证上下文', en: 'authenticated context' },
    'cross-origin-mode': { zhCN: '跨域策略', en: 'cross-origin mode' },
    'power-sampling': { zhCN: '功耗采样状态', en: 'power sampling status' },
    'thermal-sampling': { zhCN: '热状态采样', en: 'thermal sampling status' },
    'measurement-contract-version': { zhCN: '测量合同版本', en: 'measurement contract version' },
    'expected-refresh-rate': { zhCN: '预期刷新率', en: 'expected refresh rate' },
    'target-frame-duration': { zhCN: '目标帧时长', en: 'target frame duration' },
    'measurement-source': { zhCN: '刷新率来源', en: 'measurement source' },
    'measurement-confidence': { zhCN: '测量置信级别', en: 'measurement confidence' },
    'metric-catalog-version': { zhCN: '指标目录版本', en: 'metric catalog version' },
    'budget-reference': { zhCN: '诊断预算版本', en: 'diagnostic budget reference' },
    'animation-report-missing': { zhCN: '原始动画报告不存在', en: 'raw animation report is missing' },
    'animation-report-expired': { zhCN: '原始动画报告已过保留期', en: 'raw animation report has expired' },
} as const satisfies Record<LabComparisonReasonField, LabBilingualLabel>

export const LAB_COMPARISON_CAVEAT_LABELS = {
    'host-environment-unverified': {
        zhCN: '平台无法验证两次运行所在主机的负载、电源和温度状态完全一致。',
        en: 'The platform cannot verify identical host load, power, and thermal state across runs.',
    },
    'caller-attested-scenario-protocol': {
        zhCN: '场景协议摘要相同，但 selector 是否仍指向同一业务目标由运行者确认。',
        en: 'The scenario protocol digests match, but the runner attests that selectors still target the same business subject.',
    },
    'attempt-distribution-is-descriptive': {
        zhCN: '这里展示重复尝试的描述性分布，不代表真实用户总体分布。',
        en: 'These are descriptive distributions across repeated attempts, not real-user population distributions.',
    },
    'no-statistical-significance-inference': {
        zhCN: '系统没有推断统计显著性，也不会把数值变化自动解释为改善或退化。',
        en: 'No statistical significance is inferred, and numeric changes are not labeled as improvement or regression.',
    },
    'zero-baseline-percent-change-unavailable': {
        zhCN: '基线中位数为 0 的指标不能计算百分比变化，因此显示为“—”。',
        en: 'Percent change is unavailable when the Before median is zero, so it is shown as “—”.',
    },
    'percent-change-overflow-unavailable': {
        zhCN: '至少一个百分比变化超出有限数值范围，因此显示为“—”。',
        en: 'At least one percent change exceeded the finite numeric range and is shown as “—”.',
    },
} as const satisfies Record<LabComparisonCaveat, LabBilingualLabel>

export const LAB_COMPARISON_EXCLUSION_LABELS = {
    'before-missing-attempt': {
        zhCN: '基线并非每次测量都包含这个指标。',
        en: 'The Before run did not contain this metric in every measured attempt.',
    },
    'after-missing-attempt': {
        zhCN: '变更后并非每次测量都包含这个指标。',
        en: 'The After run did not contain this metric in every measured attempt.',
    },
    'before-partial-status': {
        zhCN: '基线包含部分测量证据。',
        en: 'The Before run contains partial measurement evidence.',
    },
    'after-partial-status': {
        zhCN: '变更后包含部分测量证据。',
        en: 'The After run contains partial measurement evidence.',
    },
    'before-unavailable-status': {
        zhCN: '基线至少一次测量没有可用值。',
        en: 'At least one Before attempt has no available value.',
    },
    'after-unavailable-status': {
        zhCN: '变更后至少一次测量没有可用值。',
        en: 'At least one After attempt has no available value.',
    },
    'metric-evidence-mismatch': {
        zhCN: '两次运行的证据来源或证据级别不同。',
        en: 'Evidence source or evidence level differs between the runs.',
    },
} as const satisfies Record<LabComparisonExclusionReason, LabBilingualLabel>

export const LAB_COMPARISON_DIRECTION_LABELS = {
    increase: { zhCN: '数值增加', en: 'Increase' },
    decrease: { zhCN: '数值减少', en: 'Decrease' },
    unchanged: { zhCN: '数值不变', en: 'Unchanged' },
} as const satisfies Record<LabComparisonMetric['direction'], LabBilingualLabel>

export function getLabComparisonReasonLabel(reason: LabComparisonRejectionReason): LabBilingualLabel {
    const side = SIDE_LABELS[reason.side]
    const field = LAB_COMPARISON_FIELD_LABELS[reason.field]
    if (reason.code === 'evidence-unavailable') {
        return {
            zhCN: `${side.zhCN}：${field.zhCN}，无法建立对比。`,
            en: `${side.en}: ${field.en}; comparison evidence is unavailable.`,
        }
    }
    if (reason.code === 'condition-mismatch') {
        return {
            zhCN: `${field.zhCN}不一致；必须使用测量条件相同的两次运行。`,
            en: `${field.en} differs; both runs must use the same measurement conditions.`,
        }
    }
    return {
        zhCN: `${side.zhCN}的${field.zhCN}无效，不能作为可信对比候选。`,
        en: `${side.en} has invalid ${field.en} and cannot be used as a trustworthy comparison candidate.`,
    }
}

export function getLabComparisonScopeLabel(scope: LabComparisonMetric['scope']): LabBilingualLabel {
    if (scope.level === 'action') {
        const action = scope.actionId ? ` · ${scope.actionId}` : ''
        return { zhCN: `动作级${action}`, en: `Action scope${action}` }
    }
    if (scope.level === 'subject') {
        const subject = scope.subjectKey ? ` · ${scope.subjectKey}` : ''
        const action = scope.actionId ? ` · ${scope.actionId}` : ''
        return { zhCN: `目标级${subject}${action}`, en: `Subject scope${subject}${action}` }
    }
    return { zhCN: '运行级', en: 'Run scope' }
}

export function formatLabComparisonRunLabel(run: LabRun): string {
    const compact = (value: string, maximum = 32) => (value.length > maximum ? `${value.slice(0, maximum - 1)}…` : value)
    const release = run.release?.trim()
    const browser = run.browser?.trim()
    const viewport = run.viewport ? `${run.viewport.width}×${run.viewport.height}` : ''
    const context = release ? compact(release) : browser ? compact(browser) : viewport
    return `${run.name || run.runId.slice(0, 12)} · ${formatDateTime(run.createdAt)}${context ? ` · ${context}` : ''}`
}

export function selectCompletedLabRuns(runs: readonly LabRun[]): LabRun[] {
    return runs.filter(run => run.status === 'completed')
}

export function isLabComparisonRunId(value: string): boolean {
    return LAB_RUN_ID.test(value)
}

/** Switches app scope and invalidates the pair in one navigation, preserving only the existing non-pair query state. */
export function buildLabComparisonAppSwitchHref(searchParams: Pick<URLSearchParams, 'toString'>, appId: string): string {
    const params = new URLSearchParams(searchParams.toString())
    if (appId) params.set('appId', appId)
    else params.delete('appId')
    params.delete('before')
    params.delete('after')
    const query = params.toString()
    return query ? `/labs/compare?${query}` : '/labs/compare'
}

export type LabComparisonSelectionState = 'incomplete' | 'unknown-run' | 'same-run' | 'ready'

export function getLabComparisonSelectionState(
    completedRuns: readonly LabRun[],
    beforeRunId: string,
    afterRunId: string
): LabComparisonSelectionState {
    if (!beforeRunId || !afterRunId) return 'incomplete'
    const runIds = new Set(completedRuns.map(run => run.runId))
    if (!runIds.has(beforeRunId) || !runIds.has(afterRunId)) return 'unknown-run'
    return beforeRunId === afterRunId ? 'same-run' : 'ready'
}

function formatSignedValue(value: number, unit: string, metricId: string): string {
    const formatted = formatLabMetricValue(value, unit, metricId)
    return value > 0 ? `+${formatted}` : formatted
}

export function formatLabComparisonPercent(value: number | null): string {
    if (value == null || !Number.isFinite(value)) return '—'
    const formatted = Math.abs(value).toLocaleString(undefined, { maximumFractionDigits: 2 })
    if (value > 0) return `+${formatted}%`
    if (value < 0) return `-${formatted}%`
    return '0%'
}

export type LabComparisonDistributionView = {
    n: string
    min: string
    median: string
    p75: string
    p95: string
    max: string
}

export function formatLabComparisonDistribution(
    distribution: LabComparisonDistribution,
    metric: Pick<LabComparisonMetric, 'metricId' | 'unit'>
): LabComparisonDistributionView {
    const format = (value: number) => formatLabMetricValue(value, metric.unit, metric.metricId)
    return {
        n: distribution.n.toLocaleString(),
        min: format(distribution.min),
        median: format(distribution.median),
        p75: format(distribution.p75),
        p95: format(distribution.p95),
        max: format(distribution.max),
    }
}

export type LabComparisonMetricView = {
    key: string
    metricId: string
    title: LabBilingualLabel
    scope: LabBilingualLabel
    before: LabComparisonDistributionView
    after: LabComparisonDistributionView
    delta: string
    percentChange: string
    direction: LabBilingualLabel
}

export function buildLabComparisonMetricView(metric: LabComparisonMetric): LabComparisonMetricView {
    const scope = getLabComparisonScopeLabel(metric.scope)
    return {
        key: [metric.metricId, metric.scope.level, metric.scope.actionId ?? '', metric.scope.subjectKey ?? ''].join('|'),
        metricId: metric.metricId,
        title: getLabMetricLabel(metric),
        scope,
        before: formatLabComparisonDistribution(metric.before, metric),
        after: formatLabComparisonDistribution(metric.after, metric),
        delta: formatSignedValue(metric.delta, metric.unit, metric.metricId),
        percentChange: formatLabComparisonPercent(metric.percentChange),
        direction: LAB_COMPARISON_DIRECTION_LABELS[metric.direction],
    }
}

export function getLabComparisonExcludedMetricLabel(metric: LabComparisonExcludedMetric): LabBilingualLabel {
    return getLabMetricLabel({ metricId: metric.metricId, name: metric.metricId })
}

export function getLabComparisonRequestError(status: number, serverMessage?: string | null): string {
    if (status === 404 || status === 410) {
        return '原始动画报告不存在或已过保留期，无法重新计算这次对比。请重新运行相同 Scenario 后再选择两次新的 completed 结果。'
    }
    if (status === 401 || status === 403) return '当前账号无权读取其中一次实验，请重新登录或选择自己应用下的运行。'
    return serverMessage?.trim() || '对比请求失败，请确认 Monitor 后端正在运行后重试。'
}
