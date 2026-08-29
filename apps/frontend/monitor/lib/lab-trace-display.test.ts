import assert from 'node:assert/strict'
import test from 'node:test'

import type { LabTimelineStackFrame } from '../types/lab'
import { formatLabActionStackCandidate, formatLabTimelineStackFrame, labAuthoredSourceStatusLabel } from './lab-trace-display'

const mapped: LabTimelineStackFrame = {
    functionName: 'renderHero',
    fileName: '/assets/app.js',
    lineNumber: 12,
    columnNumber: 4,
    authoredStatus: 'mapped',
    authored: { fileName: '/src/hero.ts', lineNumber: 7, columnNumber: 3 },
}

test('formats zero-based authored candidates separately from generated locations', () => {
    assert.equal(formatLabTimelineStackFrame(mapped), 'renderHero · 源码候选 /src/hero.ts:8:4 · 生成位置 /assets/app.js:12:4')
    assert.equal(formatLabActionStackCandidate(mapped), 'Source map 源码候选：/src/hero.ts:8:4；生成位置：renderHero · /assets/app.js:12:4')
})

test('explains each bounded authored-source miss without inventing a source location', () => {
    const expected: Array<[LabTimelineStackFrame['authoredStatus'], string]> = [
        ['segment-not-found', 'source map 中没有对应片段'],
        ['map-not-supplied', '没有提供匹配的 source map'],
        ['not-eligible', '该 Trace 事件的坐标基准不支持安全映射'],
    ]
    for (const [authoredStatus, reason] of expected) {
        assert.ok(formatLabTimelineStackFrame({ ...mapped, authoredStatus, authored: null }).includes(reason))
    }
})

test('labels authored-source coverage without treating candidates as causal proof', () => {
    assert.equal(labAuthoredSourceStatusLabel('measured'), '完整')
    assert.equal(labAuthoredSourceStatusLabel('partial'), '部分')
    assert.equal(labAuthoredSourceStatusLabel('not-observed'), '未观测')
})
