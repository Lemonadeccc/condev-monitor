import type { LabTimelineAuthoredSource, LabTimelineStackFrame } from '@/types/lab'

function generatedLocation(frame: LabTimelineStackFrame): string {
    return frame.fileName
        ? `${frame.fileName}${frame.lineNumber == null ? '' : `:${frame.lineNumber}${frame.columnNumber == null ? '' : `:${frame.columnNumber}`}`}`
        : '未知位置'
}

function authoredLocation(frame: LabTimelineStackFrame): string | null {
    if (frame.authoredStatus !== 'mapped' || !frame.authored) return null
    return `${frame.authored.fileName}:${frame.authored.lineNumber + 1}:${frame.authored.columnNumber + 1}`
}

export function formatLabTimelineStackFrame(frame: LabTimelineStackFrame): string {
    const generated = generatedLocation(frame)
    const authored = authoredLocation(frame)
    if (authored) return `${frame.functionName || '(anonymous)'} · 源码候选 ${authored} · 生成位置 ${generated}`
    const status =
        frame.authoredStatus === 'segment-not-found'
            ? 'source map 中没有对应片段'
            : frame.authoredStatus === 'map-not-supplied'
              ? '没有提供匹配的 source map'
              : frame.authoredStatus === 'not-eligible'
                ? '该 Trace 事件的坐标基准不支持安全映射'
                : null
    return `${frame.functionName || '(anonymous)'} · ${generated}${status ? ` · ${status}` : ''}`
}

export function formatLabActionStackCandidate(frame: LabTimelineStackFrame): string {
    const generated = `${frame.functionName || '(anonymous)'} · ${generatedLocation(frame)}`
    const authored = authoredLocation(frame)
    return authored ? `Source map 源码候选：${authored}；生成位置：${generated}` : `候选首栈：${generated}`
}

export function labAuthoredSourceStatusLabel(status: LabTimelineAuthoredSource['status']): string {
    return status === 'measured' ? '完整' : status === 'partial' ? '部分' : '未观测'
}
