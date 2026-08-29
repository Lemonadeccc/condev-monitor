import type {
    LabAnimationCoverage,
    LabAnimationCoverageItem,
    LabAnimationCoverageItemKind,
    LabAnimationCoverageItemStatus,
    LabAnimationCoverageReason,
    LabRunAnalysis,
} from '@/types/lab'

export const LAB_COVERAGE_STATUS_LABELS: Record<LabAnimationCoverageItemStatus, { zhCN: string; en: string }> = {
    passed: { zhCN: '已通过', en: 'Passed' },
    failed: { zhCN: '未通过', en: 'Failed' },
    'not-executed': { zhCN: '未执行', en: 'Not executed' },
}

export const LAB_COVERAGE_KIND_LABELS: Record<LabAnimationCoverageItemKind, { zhCN: string; en: string }> = {
    load: { zhCN: '加载', en: 'Load' },
    click: { zhCN: '点击', en: 'Click' },
    hover: { zhCN: '悬停', en: 'Hover' },
    scroll: { zhCN: '滚动', en: 'Scroll' },
    drag: { zhCN: '拖拽', en: 'Drag' },
    resize: { zhCN: '视口变化', en: 'Resize' },
    keyboard: { zhCN: '键盘', en: 'Keyboard' },
    touch: { zhCN: '触控', en: 'Touch' },
    'pointer-path': { zhCN: '指针路径', en: 'Pointer path' },
    'renderer-object': { zhCN: '渲染器对象', en: 'Renderer object' },
    'business-state': { zhCN: '业务状态', en: 'Business state' },
}

export const LAB_COVERAGE_REASON_LABELS: Record<LabAnimationCoverageReason, { zhCN: string; en: string }> = {
    'review-required': { zhCN: '动画清单仍需审核', en: 'Inventory review required' },
    'no-reviewed-scenario': { zhCN: '缺少已审核场景', en: 'No reviewed scenario' },
    'action-id-not-found': { zhCN: '场景中未找到动作', en: 'Action not found in scenario' },
    'action-not-executed': { zhCN: '动作未执行', en: 'Action was not executed' },
    'action-failed': { zhCN: '动作执行失败', en: 'Action failed' },
    'action-timed-out': { zhCN: '动作执行超时', en: 'Action timed out' },
    'outcome-contract-missing': { zhCN: '缺少完成条件或业务结果', en: 'Completion or business outcome is missing' },
    'outcome-not-observed': { zhCN: '未观测到完成条件或业务结果', en: 'Completion or business outcome was not observed' },
    'renderer-object-adapter-missing': { zhCN: '缺少渲染器对象适配器', en: 'Renderer-object adapter is missing' },
    'renderer-object-not-resolved': { zhCN: '未定位到渲染器内部对象', en: 'Renderer object was not resolved' },
    'authentication-required': { zhCN: '缺少所需的本地认证状态', en: 'Required local authentication state is missing' },
    'driver-capability-unavailable': { zhCN: '浏览器驱动不支持所需能力', en: 'Required driver capability is unavailable' },
    'partial-attempt-coverage': { zhCN: '仅部分测量尝试满足条件', en: 'Only some measurement attempts were covered' },
}

export function shortManifestHash(hash: string): string {
    return hash.length > 12 ? `${hash.slice(0, 12)}…` : hash
}

export function resolveDeclaredAnimationCoverage(analysis?: LabRunAnalysis | null): LabAnimationCoverage | null {
    return analysis?.semanticsVersion === 3 && analysis.coverage ? analysis.coverage : null
}

export function getCriticalCoverageTotals(items: LabAnimationCoverageItem[]): {
    declared: number
    passed: number
    uncovered: number
} {
    const criticalItems = items.filter(item => item.critical)
    const passed = criticalItems.filter(item => item.status === 'passed').length
    return {
        declared: criticalItems.length,
        passed,
        uncovered: criticalItems.length - passed,
    }
}
