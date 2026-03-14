import { createHash } from 'node:crypto'

import { Injectable } from '@nestjs/common'

@Injectable()
export class FingerprintService {
    compute(params: { eventType: string; message: string; info: Record<string, unknown> }): string {
        const { eventType, message, info } = params

        if (eventType === 'error' || eventType === 'whitescreen') {
            return this.computeErrorFingerprint(message, info)
        }

        return this.hash([eventType, this.normalizeMessage(message)])
    }

    private computeErrorFingerprint(message: string, info: Record<string, unknown>): string {
        const stackSignature = this.extractStackSignature(info)
        if (stackSignature) {
            return this.hash(['stack', stackSignature])
        }

        const exceptionType = this.extractExceptionType(info)
        if (exceptionType) {
            return this.hash(['type', exceptionType, this.normalizeMessage(message)])
        }

        const exceptionMessage = this.extractExceptionMessage(info) || message
        return this.hash(['message', this.normalizeMessage(exceptionMessage)])
    }

    private extractStackSignature(info: Record<string, unknown>): string {
        const frames = this.extractFrames(info)
        if (frames.length > 0) {
            return frames
                .filter(f => !this.isLibraryFrame(f))
                .slice(-8)
                .map(f => {
                    const filename = this.readStr(f, ['filename', 'abs_path', 'file']) || '<unknown>'
                    const fn = this.readStr(f, ['function', 'functionName']) || '<anonymous>'
                    const ctxLine = this.readStr(f, ['context_line', 'contextLine'])
                    return ctxLine ? `${filename}|${fn}|${ctxLine}` : `${filename}|${fn}`
                })
                .join('\x00')
        }

        const rawStack = this.readStr(info, ['stack'])
        if (rawStack) {
            return rawStack
                .split('\n')
                .map(l => l.trim())
                .filter(l => l.startsWith('at '))
                .filter(l => !this.isLibraryLine(l))
                .slice(0, 8)
                .join('\x00')
        }

        return ''
    }

    private extractFrames(info: Record<string, unknown>): Array<Record<string, unknown>> {
        if (Array.isArray(info.frames)) {
            return info.frames.filter((f): f is Record<string, unknown> => !!f && typeof f === 'object' && !Array.isArray(f))
        }

        const exception = this.firstException(info)
        if (!exception) return []

        const stacktrace = this.readObj(exception, ['stacktrace'])
        if (!stacktrace || !Array.isArray(stacktrace.frames)) return []

        return stacktrace.frames.filter((f): f is Record<string, unknown> => !!f && typeof f === 'object' && !Array.isArray(f))
    }

    private extractExceptionType(info: Record<string, unknown>): string {
        const direct = this.readStr(info, ['type', 'error_type', 'exception_type', 'name'])
        if (direct) return direct

        const exception = this.firstException(info)
        return exception ? this.readStr(exception, ['type', 'name']) : ''
    }

    private extractExceptionMessage(info: Record<string, unknown>): string {
        const direct = this.readStr(info, ['value', 'errorMessage'])
        if (direct) return direct

        const exception = this.firstException(info)
        return exception ? this.readStr(exception, ['value', 'message']) : ''
    }

    private firstException(info: Record<string, unknown>): Record<string, unknown> | null {
        const exc = this.readObj(info, ['exception'])
        if (!exc) return null

        const values = exc.values
        if (!Array.isArray(values) || values.length === 0) return null

        const first = values[0]
        return first && typeof first === 'object' && !Array.isArray(first) ? (first as Record<string, unknown>) : null
    }

    normalizeMessage(msg: string): string {
        return msg
            .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{uuid}')
            .replace(/\b\d{10,13}\b/g, '{timestamp}')
            .replace(/https?:\/\/[^\s)]+/g, '{url}')
            .replace(/\b\d+\b/g, '{n}')
            .replace(/\s+/g, ' ')
            .trim()
    }

    private isLibraryFrame(frame: Record<string, unknown>): boolean {
        const filename = this.readStr(frame, ['filename', 'abs_path', 'file'])
        return this.isLibraryPath(filename)
    }

    private isLibraryLine(line: string): boolean {
        return this.isLibraryPath(line)
    }

    private isLibraryPath(path: string): boolean {
        return /node_modules|webpack\/bootstrap|__webpack_require__|\.min\.js/.test(path)
    }

    buildEmbeddingInput(params: { message: string; info: Record<string, unknown> }): string {
        const type = this.extractExceptionType(params.info) || 'error'
        const frames = this.extractFrames(params.info)
        const topFrame = frames.length > 0 ? this.readStr(frames[frames.length - 1]!, ['function', 'functionName']) || '' : ''
        return [type, params.message, topFrame].filter(Boolean).join(' | ')
    }

    buildStackSignature(info: Record<string, unknown>, message: string): string {
        const frames = this.extractFrames(info)
        if (frames.length > 0) {
            return frames
                .slice(-20)
                .map(f => {
                    const fn = this.readStr(f, ['function', 'functionName']) || '?'
                    const file = this.readStr(f, ['filename', 'file']) || '?'
                    const line = this.readNum(f, ['lineno', 'line']) ?? 0
                    return `${fn}@${file}:${line}`
                })
                .join('\n')
        }

        const rawStack = this.readStr(info, ['stack'])
        if (rawStack) {
            return rawStack
                .split('\n')
                .map(l => l.trim())
                .filter(Boolean)
                .slice(0, 20)
                .join('\n')
        }

        return message
    }

    private readStr(source: Record<string, unknown>, keys: string[]): string {
        for (const key of keys) {
            const v = source[key]
            if (typeof v === 'string' && v.trim()) return v.trim()
        }
        return ''
    }

    private readNum(source: Record<string, unknown>, keys: string[]): number | null {
        for (const key of keys) {
            const v = source[key]
            if (typeof v === 'number' && Number.isFinite(v)) return v
        }
        return null
    }

    private readObj(source: Record<string, unknown>, keys: string[]): Record<string, unknown> | null {
        for (const key of keys) {
            const v = source[key]
            if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
        }
        return null
    }

    private hash(parts: string[]): string {
        return createHash('sha256').update(parts.join('\x00')).digest('hex').slice(0, 32)
    }
}
