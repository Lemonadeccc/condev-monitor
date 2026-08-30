import { createAnimationElementPicker } from './element-picker'
import type { AnimationGpuTimerCapability } from './host-adapters'
import { type LiveFrameRateResult, measureLiveFrameRate } from './live-frame-rate'
import {
    type AnimationLocalEvidenceSnapshot,
    type AnimationLocalMediaStageEvidence,
    projectAnimationLocalEvidenceSnapshot,
} from './local-evidence'
import { collectorStateText, overlayText, resolveOverlayLocale } from './overlay-i18n'
import {
    type AnimationOverlayViewModel,
    buildAnimationOverlayViewModel,
    formatOverlayMeasurement,
    localizeOverlayIssueHistory,
    type OverlayInteractionView,
    type OverlayIssueHistoryEntry,
    updateOverlayIssueHistory,
} from './overlay-model'
import {
    type AnimationOverlayPageEvidenceSnapshot,
    type AnimationOverlayPageEvidenceStatus,
    projectAnimationOverlayPageEvidenceSnapshot,
} from './overlay-page-evidence'
import { createRendererSurfaceInspector, type RendererSurfaceInspectorSnapshot } from './renderer-surfaces'
import type {
    AnimationElementSelectionHandle,
    AnimationElementSelectionOptions,
    AnimationElementSelectionSnapshot,
    AnimationOverlay,
    AnimationOverlayLocale,
    AnimationOverlayOptions,
    AnimationRumFamily,
    AnimationSnapshot,
    CollectorState,
    InteractionHandle,
    InteractionPerformanceSummary,
} from './types'

// cspell:ignore describedby keyshortcuts Menlo rvfc scanout Segoe

declare const process: { env?: { NODE_ENV?: string } } | undefined

let overlaySequence = 0
const MIN_REFRESH_INTERVAL_MS = 1_000
const MAX_TIMER_DELAY_MS = 2_147_483_647
const OVERLAY_STORAGE_KEY = 'condev-animation-overlay-v2'
const OVERLAY_POSITION_VERSION = 1
const OVERLAY_VIEWPORT_MARGIN_PX = 14
const OVERLAY_DRAG_THRESHOLD_PX = 5
const OVERLAY_KEYBOARD_MOVE_PX = 10
const OVERLAY_TABS = ['overview', 'pageEvidence', 'interactions', 'coverage', 'target'] as const
const RESOURCE_CATEGORY_LABEL_KEYS = {
    script: 'resourceCategoryScript',
    image: 'resourceCategoryImage',
    media: 'resourceCategoryMedia',
    'fetch-xhr': 'resourceCategoryFetchXhr',
    'link-css': 'resourceCategoryLinkCss',
    frame: 'resourceCategoryFrame',
    other: 'resourceCategoryOther',
} as const
type OverlayTab = (typeof OVERLAY_TABS)[number]
type OverlayLayout = 'compact' | 'wide'
type OverlaySurface = 'launcher' | 'panel'

interface OverlayNormalizedPosition {
    readonly xRatio: number
    readonly yRatio: number
}

interface OverlayStoredPositions {
    readonly version: typeof OVERLAY_POSITION_VERSION
    readonly launcher?: OverlayNormalizedPosition
    readonly panel?: OverlayNormalizedPosition
}

interface OverlayViewport {
    readonly left: number
    readonly top: number
    readonly width: number
    readonly height: number
}

function finiteRatio(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function rendererGpuTimerCapability(renderer: AnimationSnapshot['hostEvidence']['renderer'] | undefined): AnimationGpuTimerCapability {
    const measured = renderer?.gpuMeasuredSampleCount
    const rejected = renderer?.gpuRejectedSampleCount
    const capability = renderer?.gpuTimerCapability
    if (capability !== undefined) {
        if (typeof measured === 'number' && measured > 0 && capability !== 'supported') return 'unknown'
        if (
            (capability === 'unsupported' || capability === 'disabled') &&
            ((typeof rejected === 'number' && rejected > 0) || renderer?.gpuFrameMs !== null)
        ) {
            return 'unknown'
        }
        return capability
    }
    if (typeof measured === 'number' && measured > 0) return 'supported'
    if ((typeof rejected === 'number' && rejected > 0) || (renderer?.rejectedSampleCount ?? 0) > 0) return 'unknown'
    return (renderer?.acceptedSampleCount ?? 0) > 0 ? 'disabled' : 'unknown'
}

function gpuTimerCapabilityText(locale: AnimationOverlayLocale, capability: AnimationGpuTimerCapability): string {
    if (capability === 'supported') return overlayText(locale, 'capabilitySupported')
    if (capability === 'unsupported') return overlayText(locale, 'capabilityUnsupported')
    if (capability === 'disabled') return overlayText(locale, 'capabilityDisabled')
    return overlayText(locale, 'capabilityUnknown')
}

function normalizedPosition(value: unknown): OverlayNormalizedPosition | undefined {
    if (!value || typeof value !== 'object') return undefined
    const position = value as { xRatio?: unknown; yRatio?: unknown }
    return finiteRatio(position.xRatio) && finiteRatio(position.yRatio) ? { xRatio: position.xRatio, yRatio: position.yRatio } : undefined
}

function storedPositions(value: unknown): OverlayStoredPositions | undefined {
    if (!value || typeof value !== 'object') return undefined
    const positions = value as { version?: unknown; launcher?: unknown; panel?: unknown }
    if (positions.version !== OVERLAY_POSITION_VERSION) return undefined
    const launcher = normalizedPosition(positions.launcher)
    const panel = normalizedPosition(positions.panel)
    return {
        version: OVERLAY_POSITION_VERSION,
        ...(launcher ? { launcher } : {}),
        ...(panel ? { panel } : {}),
    }
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(Math.max(value, minimum), Math.max(minimum, maximum))
}

export interface AnimationOverlaySource {
    readonly state?: CollectorState
    snapshot(): AnimationSnapshot
    /** Optional whole-page aggregate evidence. Arbitrary provider detail is discarded before local rendering. */
    pageEvidenceSnapshot?(): unknown
    /** Optional bounded, local-only semantic evidence. It is never added to an AnimationSnapshot or RUM payload. */
    localEvidenceSnapshot?(): AnimationLocalEvidenceSnapshot
    selectElement?(element: Element, options?: AnimationElementSelectionOptions): AnimationElementSelectionHandle
}

function developmentBuild(): boolean {
    return typeof process !== 'undefined' && process.env?.NODE_ENV === 'development'
}

function noOpOverlay(refreshIntervalMs: number): AnimationOverlay {
    return {
        mounted: false,
        refreshIntervalMs,
        expanded: false,
        targetState: 'idle',
        setExpanded() {},
        toggle() {},
        startTargetPicker: () => false,
        clearTarget() {},
        refresh() {},
        destroy() {},
    }
}

function appendTextElement(documentValue: Document, parent: Node, tag: string, className: string, text: string): HTMLElement {
    const element = documentValue.createElement(tag)
    element.className = className
    element.textContent = text
    parent.appendChild(element)
    return element
}

function appendList(documentValue: Document, parent: Node, items: readonly string[]): void {
    const list = documentValue.createElement('ul')
    list.className = 'detail-list'
    for (const text of items) appendTextElement(documentValue, list, 'li', '', text)
    parent.appendChild(list)
}

function overlayTabText(locale: AnimationOverlayLocale, tab: OverlayTab): string {
    if (tab === 'target') return overlayText(locale, 'targetView')
    if (tab === 'pageEvidence') return overlayText(locale, 'pageEvidenceView')
    return overlayText(locale, tab)
}

function readCollectorState(source: AnimationOverlaySource): CollectorState | undefined {
    try {
        return source.state
    } catch {
        return undefined
    }
}

type LocalEvidenceRead =
    | { readonly status: 'absent' }
    | { readonly status: 'unavailable' }
    | { readonly status: 'available'; readonly snapshot: AnimationLocalEvidenceSnapshot }

type PageEvidenceRead =
    | { readonly status: 'absent' }
    | { readonly status: 'unavailable' }
    | { readonly status: 'available'; readonly snapshot: AnimationOverlayPageEvidenceSnapshot }

function readPageEvidenceSnapshot(source: AnimationOverlaySource): PageEvidenceRead {
    try {
        const provider = source.pageEvidenceSnapshot
        if (typeof provider !== 'function') return { status: 'absent' }
        const snapshot = projectAnimationOverlayPageEvidenceSnapshot(provider.call(source))
        return snapshot ? { status: 'available', snapshot } : { status: 'unavailable' }
    } catch {
        return { status: 'unavailable' }
    }
}

function pageEvidenceStatusText(locale: AnimationOverlayLocale, status: AnimationOverlayPageEvidenceStatus): string {
    switch (status) {
        case 'measured':
            return overlayText(locale, 'pageEvidenceStatusMeasured')
        case 'partial':
            return overlayText(locale, 'pageEvidenceStatusPartial')
        case 'not-observed':
            return overlayText(locale, 'pageEvidenceStatusNotObserved')
        case 'not-applicable':
            return overlayText(locale, 'pageEvidenceStatusNotApplicable')
        case 'unsupported':
            return overlayText(locale, 'pageEvidenceStatusUnsupported')
        case 'unknown':
            return overlayText(locale, 'pageEvidenceStatusUnknown')
    }
}

function readLocalEvidenceSnapshot(source: AnimationOverlaySource): LocalEvidenceRead {
    try {
        const provider = source.localEvidenceSnapshot
        if (typeof provider !== 'function') return { status: 'absent' }
        const snapshot = projectAnimationLocalEvidenceSnapshot(provider.call(source))
        return snapshot ? { status: 'available', snapshot } : { status: 'unavailable' }
    } catch {
        return { status: 'unavailable' }
    }
}

function safeNow(timerOwner: Window | undefined): number | null {
    try {
        return timerOwner?.performance?.now() ?? null
    } catch {
        return null
    }
}

/** Mounts an explicitly development-only Shadow DOM panel. It never starts or uploads a capture. */
export function createAnimationDevOverlay(source: AnimationOverlaySource, options: AnimationOverlayOptions = {}): AnimationOverlay {
    const requestedRefreshIntervalMs = options.refreshIntervalMs ?? MIN_REFRESH_INTERVAL_MS
    const refreshIntervalMs = Number.isFinite(requestedRefreshIntervalMs)
        ? Math.min(MAX_TIMER_DELAY_MS, Math.max(MIN_REFRESH_INTERVAL_MS, Math.floor(requestedRefreshIntervalMs)))
        : MIN_REFRESH_INTERVAL_MS
    // Unknown build modes fail closed. Callers whose bundler does not replace
    // NODE_ENV must pass production: false from an explicit development flag.
    if (options.production !== false && !developmentBuild()) return noOpOverlay(refreshIntervalMs)

    const documentCandidate = options.document ?? (typeof document === 'undefined' ? undefined : document)
    const mountTarget = documentCandidate?.body ?? documentCandidate?.documentElement
    if (!documentCandidate || !mountTarget || typeof documentCandidate.createElement !== 'function') return noOpOverlay(refreshIntervalMs)
    const documentValue = documentCandidate

    const timerOwner = documentValue.defaultView ?? (typeof window === 'undefined' ? undefined : window)
    let activeTab: OverlayTab = 'overview'
    let layout: OverlayLayout = 'wide'
    let locale: AnimationOverlayLocale = resolveOverlayLocale(options.locale, documentValue, timerOwner?.navigator?.language)
    let restoredPositions: OverlayStoredPositions = { version: OVERLAY_POSITION_VERSION }
    try {
        const stored = timerOwner?.localStorage?.getItem(OVERLAY_STORAGE_KEY)
        if (stored) {
            const parsed = JSON.parse(stored) as { tab?: unknown; layout?: unknown; locale?: unknown; positions?: unknown }
            if (OVERLAY_TABS.includes(parsed.tab as OverlayTab)) activeTab = parsed.tab as OverlayTab
            if (parsed.layout === 'compact' || parsed.layout === 'wide') layout = parsed.layout
            if ((options.locale === undefined || options.locale === 'auto') && (parsed.locale === 'en' || parsed.locale === 'zh-CN')) {
                locale = parsed.locale
            }
            restoredPositions = storedPositions(parsed.positions) ?? restoredPositions
        }
    } catch {
        // Storage is optional and may be blocked by the host document.
    }

    const host = documentValue.createElement('div')
    host.setAttribute('data-condev-animation-overlay', '')
    host.setAttribute('lang', locale)
    const shadow = host.attachShadow({ mode: 'open' })
    const style = documentValue.createElement('style')
    style.textContent = `
        :host {
            all: initial; color-scheme: dark;
            --bg: #0b0b0e; --raised: #121216; --selected: #1b1b21;
            --border: #2a2a31; --border-strong: #3a3a44;
            --text: #f4f4f6; --text-2: #b7b7c0; --text-3: #777783;
            --accent: #9b87f5; --accent-soft: rgba(155,135,245,.14);
            --danger: #ff6b6b; --warning: #f5b950; --info: #79a8ff; --success: #71d6a3;
        }
        * { box-sizing: border-box; }
        button { font: inherit; }
        .sr-only {
            position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
            clip: rect(0,0,0,0); white-space: nowrap; border: 0;
        }
        .dock {
            position: fixed; z-index: 2147483647;
            right: max(14px, env(safe-area-inset-right)); bottom: max(14px, env(safe-area-inset-bottom));
            width: 128px; height: 48px; color: var(--text); pointer-events: none;
            font: 12px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        .trigger {
            position: absolute; inset: 0; width: 128px; min-height: 48px; padding: 5px 11px 5px 6px;
            border: 1px solid var(--border-strong); border-radius: 999px; color: var(--text);
            background: rgba(11,11,14,.96); box-shadow: 0 12px 34px rgba(0,0,0,.38), inset 0 1px rgba(255,255,255,.05);
            appearance: none; cursor: grab; pointer-events: auto; display: grid; touch-action: none; user-select: none;
            grid-template-columns: 36px 1fr auto; align-items: center; gap: 7px; text-align: left;
            transition: transform 120ms ease-out, border-color 120ms ease-out, background-color 120ms ease-out;
        }
        .trigger-brand {
            width: 36px; height: 36px; border-radius: 999px; display: grid; place-items: center;
            color: #0b0913; background: linear-gradient(145deg,#aa98ff,#7058d6);
            box-shadow: inset 0 1px rgba(255,255,255,.4); font: 800 20px/1 ui-sans-serif, system-ui, sans-serif;
        }
        .trigger-copy { min-width: 0; display: grid; }
        .trigger-copy strong { font-size: 11px; font-weight: 680; line-height: 1.25; letter-spacing: -.01em; }
        .trigger-copy small { color: var(--text-3); font-size: 9px; line-height: 1.25; }
        .trigger-state { width: 7px; height: 7px; border-radius: 999px; background: var(--text-3); box-shadow: 0 0 0 3px rgba(119,119,131,.12); }
        .trigger[data-collector-state='running'] .trigger-state { background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
        .trigger[data-collector-state='idle'] .trigger-state { background: var(--warning); }
        .trigger-badge {
            position: absolute; top: -5px; right: -4px; min-width: 19px; height: 19px; padding: 0 5px;
            border: 2px solid var(--bg); border-radius: 999px; display: grid; place-items: center;
            color: #170d00; background: var(--warning); font: 750 9px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
            font-variant-numeric: tabular-nums;
        }
        .trigger-badge[data-visible='false'] { display: none; }
        .trigger[data-dragging='true'] { cursor: grabbing; transition: none; }
        .trigger:focus-visible, .panel:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
        .trigger:active, .icon-button:active, .tab:active, .issue-button:active, .interaction-button:active, .coverage-button:active { transform: scale(.97); }
        .panel {
            position: fixed; right: max(14px,env(safe-area-inset-right));
            bottom: max(72px,calc(58px + env(safe-area-inset-bottom))); width: min(430px,calc(100vw - 28px));
            height: min(640px,calc(100vh - 90px)); min-height: min(500px,calc(100vh - 90px)); overflow: hidden;
            border: 1px solid var(--border); border-radius: 14px; color: var(--text); background: rgba(11,11,14,.985);
            box-shadow: 0 28px 80px rgba(0,0,0,.48), inset 0 1px rgba(255,255,255,.045);
            pointer-events: auto; transform-origin: bottom right; opacity: 1; visibility: visible; transform: translateY(0) scale(1);
            transition: opacity 180ms cubic-bezier(.2,.8,.2,1), transform 180ms cubic-bezier(.2,.8,.2,1), visibility 0s linear 0s;
            display: grid; grid-template-rows: auto auto auto auto minmax(0,1fr) auto; overscroll-behavior: contain;
        }
        .dock[data-layout='wide'] .panel { width: min(760px,calc(100vw - 28px)); }
        .dock[data-expanded='false'] .panel {
            opacity: 0; visibility: hidden; pointer-events: none; transform: translateY(7px) scale(.975);
            transition: opacity 140ms cubic-bezier(.4,0,1,1), transform 140ms cubic-bezier(.4,0,1,1), visibility 0s linear 140ms;
        }
        .panel-header { min-height: 58px; padding: 10px 10px 9px 14px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; gap: 12px; }
        .product {
            min-width: 0; display: flex; align-items: center; gap: 9px; cursor: grab;
            touch-action: none; user-select: none; border-radius: 9px;
        }
        .product[data-dragging='true'] { cursor: grabbing; }
        .product-mark { width: 28px; height: 28px; flex: 0 0 auto; border-radius: 8px; display: grid; place-items: center; color: var(--accent); background: var(--accent-soft); border: 1px solid rgba(155,135,245,.24); font: 750 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace; }
        .product-copy { min-width: 0; }
        .product-copy h2 { margin: 0; font-size: 13px; line-height: 1.25; font-weight: 680; letter-spacing: -.015em; }
        .product-copy p { margin: 2px 0 0; color: var(--text-3); font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .header-actions { display: flex; gap: 4px; }
        .icon-button { width: 44px; height: 44px; padding: 0; border: 0; border-radius: 9px; color: var(--text-2); background: transparent; cursor: pointer; display: grid; place-items: center; font-size: 18px; transition: color 120ms ease-out, background-color 120ms ease-out, transform 120ms ease-out; }
        .picker-button[data-picker-state='picking'] { color: var(--accent); background: var(--accent-soft); }
        .picker-button:disabled { color: var(--text-3); cursor: not-allowed; opacity: .45; }
        .locale-toggle { font-size: 10px; font-weight: 720; letter-spacing: .02em; }
        .diagnosis { padding: 12px 14px 11px; border-bottom: 1px solid var(--border); display: grid; gap: 4px; }
        .diagnosis-row { display: flex; align-items: center; gap: 7px; }
        .diagnosis-dot { width: 7px; height: 7px; border-radius: 999px; background: var(--info); }
        .diagnosis[data-state='attention'] .diagnosis-dot { background: var(--warning); }
        .diagnosis[data-state='steady'] .diagnosis-dot { background: var(--success); }
        .diagnosis h3 { margin: 0; font-size: 12px; line-height: 1.35; font-weight: 680; }
        .diagnosis-summary { margin: 0; color: var(--text-2); font-size: 10.5px; line-height: 1.45; }
        .capture-meta { color: var(--text-3); font: 9.5px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace; font-variant-numeric: tabular-nums; }
        .metric-grid { padding: 10px 12px; border-bottom: 1px solid var(--border); display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 7px; }
        .dock[data-layout='wide'] .metric-grid { grid-template-columns: repeat(4,minmax(0,1fr)); }
        .metric { min-width: 0; padding: 9px 10px; border: 1px solid var(--border); border-radius: 9px; background: var(--raised); }
        .metric-label { color: var(--text-3); font-size: 9.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .metric-value { margin-top: 2px; font: 680 15px/1.25 ui-monospace,SFMono-Regular,Menlo,monospace; font-variant-numeric: tabular-nums; }
        .metric[data-tone='warning'] .metric-value { color: var(--warning); }
        .metric[data-tone='unknown'] .metric-value { color: var(--text-3); }
        .metric-context { margin-top: 2px; color: var(--text-3); font-size: 8.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .tabs { height: 49px; padding: 2px 8px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 3px; }
        .tab { flex: 1 1 0; min-width: 0; min-height: 44px; padding: 0 6px; border: 0; border-radius: 8px; color: var(--text-3); background: transparent; cursor: pointer; font-size: 10.5px; font-weight: 630; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: color 120ms ease-out, background-color 120ms ease-out, transform 120ms ease-out; }
        .tab[aria-selected='true'] { color: var(--text); background: var(--selected); }
        .content { min-height: 0; overflow: hidden; }
        .tab-panel { height: 100%; min-height: 0; }
        .tab-panel[hidden] { display: none; }
        .overview-panel { display: grid; grid-template-rows: auto auto minmax(0,1fr); }
        .overview-evidence { padding: 8px 11px; border-bottom: 1px solid var(--border); display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 7px; }
        .evidence-card { min-width: 0; padding: 8px 9px; border: 1px solid var(--border); border-radius: 9px; background: var(--raised); }
        .evidence-card-header { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
        .evidence-card-header strong { color: var(--text-2); font-size: 9.5px; font-weight: 690; }
        .evidence-card-header span { color: var(--text-3); font: 8.5px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace; }
        .evidence-card[data-status='sufficient'] .evidence-card-header span { color: var(--success); }
        .evidence-card[data-status='insufficient'] .evidence-card-header span { color: var(--warning); }
        .evidence-durations, .vital-grid { margin-top: 5px; display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 5px; }
        .evidence-duration span, .vital-item span { display: block; color: var(--text-3); font-size: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .evidence-duration strong, .vital-item strong { display: block; margin-top: 1px; color: var(--text); font: 620 10px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace; font-variant-numeric: tabular-nums; }
        .vital-item[data-observed='false'] strong { color: var(--text-3); }
        .evidence-reasons { margin: 5px 0 0; color: var(--text-3); font-size: 8.5px; line-height: 1.4; }
        .local-evidence-panel { max-height: 178px; padding: 9px 11px; overflow: auto; overscroll-behavior: contain; border-bottom: 1px solid var(--border); background: rgba(155,135,245,.045); scrollbar-width: thin; scrollbar-color: var(--border-strong) transparent; }
        .local-evidence-panel[hidden] { display: none; }
        .local-evidence-panel::-webkit-scrollbar { width: 6px; height: 6px; }
        .local-evidence-panel::-webkit-scrollbar-thumb { border-radius: 999px; background: var(--border-strong); }
        .local-evidence-header { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
        .local-evidence-header strong { color: var(--accent); font-size: 9.5px; font-weight: 690; }
        .local-evidence-header span { color: var(--text-3); font: 8.5px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace; }
        .local-evidence-boundary { margin: 4px 0 7px; color: var(--text-3); font-size: 8.5px; line-height: 1.4; }
        .local-evidence-groups { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 7px; }
        .local-evidence-group { min-width: 0; padding: 7px 8px; border: 1px solid rgba(155,135,245,.22); border-radius: 8px; background: var(--raised); }
        .local-evidence-group h4 { margin: 0 0 5px; color: var(--text-2); font-size: 9px; font-weight: 670; }
        .local-evidence-record { padding: 5px 0; border-top: 1px solid var(--border); }
        .local-evidence-record:first-of-type { border-top: 0; padding-top: 0; }
        .local-evidence-record strong { display: block; color: var(--text); font-size: 9px; font-weight: 620; }
        .local-evidence-record span { display: block; margin-top: 2px; color: var(--text-3); font: 8px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; overflow-wrap: anywhere; }
        .local-evidence-empty { color: var(--text-3); font-size: 8.5px; }
        .page-evidence-tab { min-height: 0; overflow: hidden; }
        .page-evidence-panel { height: 100%; min-height: 0; padding: 11px; overflow: auto; overscroll-behavior: contain; background: rgba(80,178,255,.045); scrollbar-width: thin; scrollbar-color: var(--border-strong) transparent; }
        .page-evidence-panel[hidden] { display: none; }
        .page-evidence-panel::-webkit-scrollbar { width: 6px; height: 6px; }
        .page-evidence-panel::-webkit-scrollbar-thumb { border-radius: 999px; background: var(--border-strong); }
        .page-evidence-header { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
        .page-evidence-header strong { color: var(--accent-2); font-size: 9.5px; font-weight: 690; }
        .page-evidence-header span { color: var(--text-3); font: 8.5px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace; }
        .page-evidence-boundary { margin: 4px 0 7px; color: var(--text-3); font-size: 8.5px; line-height: 1.4; }
        .page-evidence-groups { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 7px; }
        .dock[data-layout='compact'] .page-evidence-groups { grid-template-columns: minmax(0,1fr); }
        .page-evidence-group { min-width: 0; padding: 7px 8px; border: 1px solid rgba(80,178,255,.2); border-radius: 8px; background: var(--raised); }
        .page-evidence-group h4 { margin: 0 0 5px; color: var(--text-2); font-size: 9px; font-weight: 670; }
        .page-evidence-group p { margin: 3px 0 0; color: var(--text-3); font: 8px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; overflow-wrap: anywhere; }
        .page-evidence-group [data-review-candidate='true'] { color: var(--warning); }
        .workspace { height: 100%; min-height: 0; display: grid; grid-template-rows: minmax(140px,.8fr) minmax(190px,1.2fr); }
        .dock[data-layout='wide'] .workspace { grid-template-columns: minmax(250px,.78fr) minmax(360px,1.22fr); grid-template-rows: minmax(0,1fr); }
        .list-pane, .detail-pane { min-width: 0; min-height: 0; overflow: auto; overscroll-behavior: contain; }
        .list-pane, .detail-pane, .coverage-panel { scrollbar-width: thin; scrollbar-color: var(--border-strong) transparent; }
        .list-pane::-webkit-scrollbar, .detail-pane::-webkit-scrollbar, .coverage-panel::-webkit-scrollbar { width: 6px; height: 6px; }
        .list-pane::-webkit-scrollbar-thumb, .detail-pane::-webkit-scrollbar-thumb, .coverage-panel::-webkit-scrollbar-thumb { border-radius: 999px; background: var(--border-strong); }
        .list-pane { padding: 11px; border-bottom: 1px solid var(--border); }
        .dock[data-layout='wide'] .list-pane { border-right: 1px solid var(--border); border-bottom: 0; }
        .detail-pane { padding: 14px; }
        .section-heading { margin: 0 0 8px; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .section-heading h3, .detail-pane h3 { margin: 0; font-size: 10px; font-weight: 720; letter-spacing: .07em; text-transform: uppercase; color: var(--text-2); }
        .count { color: var(--text-3); font: 9px/1 ui-monospace,SFMono-Regular,Menlo,monospace; }
        .issue-list, .interaction-list, .coverage-grid { display: grid; gap: 5px; }
        .issue-button, .interaction-button, .coverage-button { width: 100%; min-height: 54px; padding: 8px 9px; border: 1px solid transparent; border-radius: 9px; color: var(--text-2); background: transparent; text-align: left; cursor: pointer; display: grid; gap: 4px; transition: border-color 120ms ease-out, background-color 120ms ease-out, transform 120ms ease-out; }
        .issue-button[data-selected='true'], .interaction-button[data-selected='true'], .coverage-button[data-selected='true'] { border-color: var(--border-strong); background: var(--selected); }
        .issue-button[data-active='false'] { opacity: .64; }
        .issue-top, .interaction-top { min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .issue-title, .interaction-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); font-size: 10.5px; font-weight: 640; }
        .title-with-dot { min-width: 0; display: flex; align-items: center; gap: 7px; }
        .severity { width: 7px; height: 7px; flex: 0 0 auto; border-radius: 999px; background: var(--info); }
        .issue-button[data-severity='warning'] .severity, .interaction-button[data-status='warning'] .severity { background: var(--warning); }
        .issue-button[data-severity='critical'] .severity { background: var(--danger); }
        .issue-meta, .interaction-meta { display: flex; align-items: center; justify-content: space-between; gap: 7px; color: var(--text-3); font: 9px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace; font-variant-numeric: tabular-nums; }
        .issue-meta span, .interaction-meta span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .empty { min-height: 110px; padding: 18px 12px; border: 1px dashed var(--border); border-radius: 9px; display: grid; place-content: center; gap: 5px; text-align: center; }
        .empty strong { color: var(--text-2); font-size: 11px; }
        .empty span { max-width: 280px; color: var(--text-3); font-size: 10px; line-height: 1.45; }
        .detail-kicker { color: var(--text-3); font: 9px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace; text-transform: uppercase; letter-spacing: .06em; }
        .detail-title { margin: 5px 0 2px; color: var(--text); font-size: 16px; line-height: 1.3; font-weight: 690; letter-spacing: -.02em; }
        .detail-meta { color: var(--text-3); font-size: 9.5px; }
        .comparison { margin: 12px 0; display: grid; grid-template-columns: 1fr auto 1fr; align-items: stretch; gap: 7px; }
        .comparison-card { padding: 9px; border: 1px solid var(--border); border-radius: 9px; background: var(--raised); }
        .comparison-card span { display: block; color: var(--text-3); font-size: 9px; }
        .comparison-card strong { display: block; margin-top: 2px; font: 680 13px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace; font-variant-numeric: tabular-nums; }
        .comparison-arrow { align-self: center; color: var(--text-3); }
        .detail-section { margin-top: 14px; }
        .detail-section h4 { margin: 0 0 6px; color: var(--text-2); font-size: 10px; font-weight: 690; }
        .detail-section p { margin: 0; color: var(--text-2); font-size: 10.5px; line-height: 1.52; }
        .detail-list { margin: 0; padding-left: 17px; color: var(--text-2); font-size: 10.5px; line-height: 1.5; }
        .detail-list li + li { margin-top: 5px; }
        .verification { padding: 9px 10px; border-left: 2px solid var(--accent); border-radius: 0 7px 7px 0; background: var(--accent-soft); }
        .interaction-facts, .resource-facts { margin: 12px 0; display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 7px; }
        .fact { padding: 9px; border: 1px solid var(--border); border-radius: 8px; background: var(--raised); }
        .fact span { display: block; color: var(--text-3); font-size: 9px; }
        .fact strong { display: block; margin-top: 2px; color: var(--text); font: 620 11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace; font-variant-numeric: tabular-nums; }
        .resource-category-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 7px; }
        .resource-category { min-width: 0; padding: 8px 9px; border: 1px solid var(--border); border-radius: 8px; background: var(--raised); }
        .resource-category strong { display: block; color: var(--text-2); font-size: 9.5px; font-weight: 650; }
        .resource-category span { display: block; margin-top: 2px; color: var(--text-3); font: 8.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
        .coverage-note { margin: 0; color: var(--text-3); font-size: 10px; line-height: 1.5; }
        .coverage-button { min-width: 0; min-height: 60px; grid-template-columns: 1fr auto; }
        .coverage-button strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--text-2); font-size: 10.5px; font-weight: 620; }
        .coverage-button small { color: var(--text-3); font-size: 9px; }
        .coverage-status { padding: 2px 6px; border: 1px solid var(--border-strong); border-radius: 999px; color: var(--text-3); font: 8.5px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace; }
        .coverage-button[data-status='measured'] .coverage-status { color: var(--success); border-color: rgba(113,214,163,.3); }
        .coverage-button[data-status='partial'] .coverage-status { color: var(--warning); border-color: rgba(245,185,80,.3); }
        .target-card { padding: 10px; border: 1px solid var(--border); border-radius: 9px; background: var(--raised); display: grid; gap: 5px; }
        .target-card strong { color: var(--text); font-size: 11px; }
        .target-card span { color: var(--text-3); font: 9px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; }
        .surface-panel { margin-bottom: 12px; padding-bottom: 12px; border-bottom: 1px solid var(--border); display: grid; gap: 7px; }
        .surface-heading { min-height: 28px; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .surface-heading h3 { margin: 0; color: var(--text-2); font-size: 10px; font-weight: 630; }
        .surface-heading span { color: var(--text-3); font: 9px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace; }
        .surface-actions { display: grid; grid-template-columns: 1fr auto; gap: 6px; }
        .surface-toggle, .surface-refresh { min-height: 38px; padding: 0 9px; border: 1px solid var(--border-strong); border-radius: 8px;
            color: var(--text-2); background: transparent; cursor: pointer; font-size: 9.5px; }
        .surface-toggle[data-enabled='true'] { color: var(--accent); border-color: rgba(155,135,245,.45); background: var(--accent-soft); }
        .surface-refresh:disabled { color: var(--text-3); cursor: not-allowed; opacity: .45; }
        .surface-help { margin: 0; color: var(--text-3); font-size: 9px; line-height: 1.45; }
        .surface-list { display: grid; gap: 5px; }
        .surface-button { width: 100%; min-height: 48px; padding: 7px 8px; border: 1px solid transparent; border-radius: 8px;
            color: var(--text-2); background: transparent; text-align: left; cursor: pointer; display: grid; grid-template-columns: 1fr auto;
            align-items: center; gap: 3px 8px; }
        .surface-button[data-selected='true'] { border-color: rgba(155,135,245,.55); background: var(--accent-soft); }
        .surface-button strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--text-2); font-size: 10px; }
        .surface-button small { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--text-3); font: 8.5px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace; }
        .surface-evidence { grid-row: 1 / span 2; grid-column: 2; padding: 2px 5px; border: 1px solid var(--border-strong); border-radius: 999px;
            color: var(--text-3); font: 8px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace; }
        .surface-button[data-evidence-status='measured'] .surface-evidence { color: var(--success); border-color: rgba(113,214,163,.3); }
        .target-actions { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 6px; }
        .text-button { min-height: 44px; padding: 0 10px; border: 1px solid var(--border-strong); border-radius: 8px; color: var(--text-2); background: transparent; cursor: pointer; font-size: 10px; }
        .text-button:disabled { color: var(--text-3); cursor: not-allowed; opacity: .45; }
        .target-recording-copy { line-height: 1.5; }
        .target-properties { display: flex; flex-wrap: wrap; gap: 5px; }
        .target-properties span { padding: 3px 6px; border: 1px solid var(--border); border-radius: 999px; color: var(--text-2); background: var(--raised); font: 9px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace; }
        .target-boundary { margin-top: 12px; padding: 9px 10px; border-left: 2px solid var(--warning); background: rgba(245,185,80,.08); color: var(--text-2); font-size: 10px; line-height: 1.5; }
        .panel-footer { min-height: 34px; padding: 7px 12px; border-top: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; gap: 10px; color: var(--text-3); background: rgba(18,18,22,.66); font: 8.5px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace; }
        .local-label { color: var(--accent); font-weight: 720; letter-spacing: .08em; }
        @media (hover: hover) and (pointer: fine) {
            .trigger:hover { border-color: #575360; background: #121216; }
            .icon-button:hover, .tab:hover { color: var(--text); background: var(--selected); }
            .issue-button:hover, .interaction-button:hover, .coverage-button:hover, .surface-button:hover { background: var(--raised); }
        }
        @media (max-width: 780px) {
            .layout-toggle { display: none; }
            .dock[data-layout='wide'] .workspace { grid-template-columns: 1fr; grid-template-rows: minmax(140px,.8fr) minmax(190px,1.2fr); }
            .dock[data-layout='wide'] .list-pane { border-right: 0; border-bottom: 1px solid var(--border); }
            .dock[data-layout='wide'] .metric-grid { grid-template-columns: repeat(2,minmax(0,1fr)); }
        }
        @media (max-width: 540px) { .overview-evidence { grid-template-columns: 1fr; } }
        @media (max-height: 590px) { .panel { min-height: 0; } .diagnosis-summary, .metric-context { display: none; } }
        @media (prefers-reduced-motion: reduce) {
            .trigger, .panel, .dock[data-expanded='false'] .panel, .icon-button, .tab, .issue-button, .interaction-button, .coverage-button { transition: none; }
        }
    `

    const dock = documentValue.createElement('div')
    dock.className = 'dock'
    const panel = documentValue.createElement('section')
    const panelId = `condev-animation-overlay-panel-${++overlaySequence}`
    panel.className = 'panel'
    panel.setAttribute('id', panelId)
    panel.setAttribute('role', 'region')
    panel.setAttribute('aria-label', overlayText(locale, 'panelAria'))
    panel.setAttribute('tabindex', '0')
    const launcherMoveHelpId = `${panelId}-launcher-move-help`
    const panelMoveHelpId = `${panelId}-panel-move-help`
    const launcherMoveHelp = documentValue.createElement('span')
    launcherMoveHelp.className = 'sr-only'
    launcherMoveHelp.textContent = overlayText(locale, 'launcherMoveHelp')
    launcherMoveHelp.setAttribute('id', launcherMoveHelpId)
    const panelMoveHelp = documentValue.createElement('span')
    panelMoveHelp.className = 'sr-only'
    panelMoveHelp.textContent = overlayText(locale, 'panelMoveHelp')
    panelMoveHelp.setAttribute('id', panelMoveHelpId)

    const trigger = documentValue.createElement('button')
    trigger.className = 'trigger'
    trigger.setAttribute('type', 'button')
    trigger.setAttribute('aria-controls', panelId)
    trigger.setAttribute('aria-describedby', launcherMoveHelpId)
    trigger.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight Alt+Home')
    const triggerBrand = appendTextElement(documentValue, trigger, 'span', 'trigger-brand', '∿')
    triggerBrand.setAttribute('aria-hidden', 'true')
    const triggerCopy = documentValue.createElement('span')
    triggerCopy.className = 'trigger-copy'
    const triggerLabel = appendTextElement(documentValue, triggerCopy, 'strong', '', overlayText(locale, 'motion'))
    const triggerStateLabel = appendTextElement(
        documentValue,
        triggerCopy,
        'small',
        '',
        collectorStateText(locale, readCollectorState(source))
    )
    const triggerState = documentValue.createElement('span')
    triggerState.className = 'trigger-state'
    triggerState.setAttribute('aria-hidden', 'true')
    const triggerBadge = documentValue.createElement('span')
    triggerBadge.className = 'trigger-badge'
    triggerBadge.textContent = '0'
    triggerBadge.setAttribute('aria-label', overlayText(locale, 'findingsMany', { count: 0 }))
    triggerBadge.setAttribute('data-visible', 'false')
    trigger.append(triggerCopy, triggerState, triggerBadge)

    const panelHeader = documentValue.createElement('header')
    panelHeader.className = 'panel-header'
    const product = documentValue.createElement('div')
    product.className = 'product'
    product.setAttribute('data-overlay-panel-drag-handle', '')
    product.setAttribute('tabindex', '0')
    product.setAttribute('role', 'group')
    product.setAttribute('aria-label', overlayText(locale, 'movePanel'))
    product.setAttribute('aria-describedby', panelMoveHelpId)
    product.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight Alt+Home')
    const productMark = appendTextElement(documentValue, product, 'span', 'product-mark', 'CM')
    productMark.setAttribute('aria-hidden', 'true')
    const productCopy = documentValue.createElement('div')
    productCopy.className = 'product-copy'
    const productTitle = appendTextElement(documentValue, productCopy, 'h2', '', overlayText(locale, 'motionConsole'))
    const productState = appendTextElement(documentValue, productCopy, 'p', '', collectorStateText(locale, readCollectorState(source)))
    product.appendChild(productCopy)
    const headerActions = documentValue.createElement('div')
    headerActions.className = 'header-actions'
    const pickerButton = appendTextElement(documentValue, headerActions, 'button', 'icon-button picker-button', '⌖')
    pickerButton.setAttribute('type', 'button')
    pickerButton.setAttribute('data-animation-target-picker', '')
    pickerButton.setAttribute('data-picker-state', 'idle')
    pickerButton.setAttribute('aria-pressed', 'false')
    ;(pickerButton as HTMLButtonElement).disabled = typeof source.selectElement !== 'function'
    const localeButton = appendTextElement(
        documentValue,
        headerActions,
        'button',
        'icon-button locale-toggle',
        locale === 'en' ? '中' : 'EN'
    )
    localeButton.setAttribute('type', 'button')
    localeButton.setAttribute('data-overlay-locale-toggle', '')
    const layoutButton = appendTextElement(documentValue, headerActions, 'button', 'icon-button layout-toggle', '⤢')
    layoutButton.setAttribute('type', 'button')
    layoutButton.setAttribute('title', overlayText(locale, 'toggleWorkbench'))
    const closeButton = appendTextElement(documentValue, headerActions, 'button', 'icon-button', '×')
    closeButton.setAttribute('type', 'button')
    closeButton.setAttribute('aria-label', overlayText(locale, 'closeMonitor'))
    closeButton.setAttribute('title', overlayText(locale, 'close'))
    panelHeader.append(product, headerActions)

    const diagnosis = documentValue.createElement('section')
    diagnosis.className = 'diagnosis'
    const diagnosisRow = documentValue.createElement('div')
    diagnosisRow.className = 'diagnosis-row'
    const diagnosisDot = documentValue.createElement('span')
    diagnosisDot.className = 'diagnosis-dot'
    diagnosisDot.setAttribute('aria-hidden', 'true')
    const diagnosisHeadline = appendTextElement(documentValue, diagnosisRow, 'h3', '', overlayText(locale, 'waitingSnapshot'))
    diagnosisRow.appendChild(diagnosisDot)
    // Keep the visual indicator before the text without relying on innerHTML.
    diagnosisRow.replaceChildren(diagnosisDot, diagnosisHeadline)
    const diagnosisSummary = appendTextElement(documentValue, diagnosis, 'p', 'diagnosis-summary', overlayText(locale, 'openForEvidence'))
    const captureMeta = appendTextElement(
        documentValue,
        diagnosis,
        'div',
        'capture-meta',
        collectorStateText(locale, readCollectorState(source))
    )
    diagnosis.replaceChildren(diagnosisRow, diagnosisSummary, captureMeta)

    const metricGrid = documentValue.createElement('section')
    metricGrid.className = 'metric-grid'
    metricGrid.setAttribute('aria-label', overlayText(locale, 'primaryMeasurementsAria'))

    const tabs = documentValue.createElement('div')
    tabs.className = 'tabs'
    tabs.setAttribute('role', 'tablist')
    tabs.setAttribute('aria-label', overlayText(locale, 'viewsAria'))
    const tabButtons = new Map<OverlayTab, HTMLButtonElement>()

    const content = documentValue.createElement('div')
    content.className = 'content'
    const tabPanels = new Map<OverlayTab, HTMLElement>()
    const overviewPanel = documentValue.createElement('section')
    overviewPanel.className = 'tab-panel overview-panel'
    const overviewPanelId = `${panelId}-overview`
    overviewPanel.setAttribute('id', overviewPanelId)
    overviewPanel.setAttribute('role', 'tabpanel')
    const overviewWorkspace = documentValue.createElement('div')
    overviewWorkspace.className = 'workspace'
    const overviewEvidence = documentValue.createElement('section')
    overviewEvidence.className = 'overview-evidence'
    const localEvidencePanel = documentValue.createElement('section')
    localEvidencePanel.className = 'local-evidence-panel'
    localEvidencePanel.setAttribute('data-overlay-local-evidence', '')
    localEvidencePanel.hidden = true
    const issuePane = documentValue.createElement('div')
    issuePane.className = 'list-pane'
    const issueHeading = documentValue.createElement('div')
    issueHeading.className = 'section-heading'
    const issueHeadingLabel = appendTextElement(documentValue, issueHeading, 'h3', '', overlayText(locale, 'issueHistory'))
    const issueCount = appendTextElement(
        documentValue,
        issueHeading,
        'span',
        'count',
        overlayText(locale, 'currentRetained', { current: 0, retained: 0 })
    )
    const issueList = documentValue.createElement('div')
    issueList.className = 'issue-list'
    issuePane.append(issueHeading, issueList)
    const issueDetail = documentValue.createElement('article')
    issueDetail.className = 'detail-pane'
    overviewWorkspace.append(issuePane, issueDetail)
    overviewPanel.append(overviewEvidence, localEvidencePanel, overviewWorkspace)

    const pageEvidenceTabPanel = documentValue.createElement('section')
    pageEvidenceTabPanel.className = 'tab-panel page-evidence-tab'
    const pageEvidenceTabPanelId = `${panelId}-page-evidence`
    pageEvidenceTabPanel.setAttribute('id', pageEvidenceTabPanelId)
    pageEvidenceTabPanel.setAttribute('role', 'tabpanel')
    const pageEvidencePanel = documentValue.createElement('section')
    pageEvidencePanel.className = 'page-evidence-panel'
    pageEvidencePanel.setAttribute('data-overlay-page-evidence', '')
    pageEvidencePanel.hidden = true
    pageEvidenceTabPanel.appendChild(pageEvidencePanel)

    const interactionsPanel = documentValue.createElement('section')
    interactionsPanel.className = 'tab-panel'
    const interactionsPanelId = `${panelId}-interactions`
    interactionsPanel.setAttribute('id', interactionsPanelId)
    interactionsPanel.setAttribute('role', 'tabpanel')
    const interactionWorkspace = documentValue.createElement('div')
    interactionWorkspace.className = 'workspace'
    const interactionPane = documentValue.createElement('div')
    interactionPane.className = 'list-pane'
    const interactionHeading = documentValue.createElement('div')
    interactionHeading.className = 'section-heading'
    const interactionHeadingLabel = appendTextElement(
        documentValue,
        interactionHeading,
        'h3',
        '',
        overlayText(locale, 'recentInteractions')
    )
    const interactionCount = appendTextElement(
        documentValue,
        interactionHeading,
        'span',
        'count',
        overlayText(locale, 'retained', { count: 0 })
    )
    const interactionList = documentValue.createElement('div')
    interactionList.className = 'interaction-list'
    interactionPane.append(interactionHeading, interactionList)
    const interactionDetail = documentValue.createElement('article')
    interactionDetail.className = 'detail-pane'
    interactionWorkspace.append(interactionPane, interactionDetail)
    interactionsPanel.appendChild(interactionWorkspace)

    const coveragePanel = documentValue.createElement('section')
    coveragePanel.className = 'tab-panel coverage-panel'
    const coveragePanelId = `${panelId}-coverage`
    coveragePanel.setAttribute('id', coveragePanelId)
    coveragePanel.setAttribute('role', 'tabpanel')
    const coverageWorkspace = documentValue.createElement('div')
    coverageWorkspace.className = 'workspace'
    const coveragePane = documentValue.createElement('div')
    coveragePane.className = 'list-pane'
    const coverageHeading = documentValue.createElement('div')
    coverageHeading.className = 'section-heading'
    const coverageHeadingLabel = appendTextElement(documentValue, coverageHeading, 'h3', '', overlayText(locale, 'metricCoverage'))
    const coverageCount = appendTextElement(
        documentValue,
        coverageHeading,
        'span',
        'count',
        overlayText(locale, 'coverageCount', { count: 0 })
    )
    const coverageGrid = documentValue.createElement('div')
    coverageGrid.className = 'coverage-grid'
    coveragePane.append(coverageHeading, coverageGrid)
    const coverageDetail = documentValue.createElement('article')
    coverageDetail.className = 'detail-pane'
    coverageWorkspace.append(coveragePane, coverageDetail)
    coveragePanel.appendChild(coverageWorkspace)

    const targetPanel = documentValue.createElement('section')
    targetPanel.className = 'tab-panel'
    const targetPanelId = `${panelId}-target`
    targetPanel.setAttribute('id', targetPanelId)
    targetPanel.setAttribute('role', 'tabpanel')
    const targetWorkspace = documentValue.createElement('div')
    targetWorkspace.className = 'workspace'
    const targetPane = documentValue.createElement('div')
    targetPane.className = 'list-pane'
    const rendererSurfacePanel = documentValue.createElement('section')
    rendererSurfacePanel.className = 'surface-panel'
    rendererSurfacePanel.setAttribute('data-renderer-surface-panel', '')
    const rendererSurfaceHeading = documentValue.createElement('div')
    rendererSurfaceHeading.className = 'surface-heading'
    const rendererSurfaceHeadingLabel = appendTextElement(
        documentValue,
        rendererSurfaceHeading,
        'h3',
        '',
        overlayText(locale, 'rendererSurfaces')
    )
    const rendererSurfaceCount = appendTextElement(
        documentValue,
        rendererSurfaceHeading,
        'span',
        '',
        overlayText(locale, 'rendererSurfaceCount', { count: 0 })
    )
    const rendererSurfaceActions = documentValue.createElement('div')
    rendererSurfaceActions.className = 'surface-actions'
    const rendererSurfaceToggle = appendTextElement(
        documentValue,
        rendererSurfaceActions,
        'button',
        'surface-toggle',
        overlayText(locale, 'showRendererSurfaces')
    )
    rendererSurfaceToggle.setAttribute('type', 'button')
    rendererSurfaceToggle.setAttribute('data-renderer-surface-toggle', '')
    rendererSurfaceToggle.setAttribute('data-enabled', 'false')
    rendererSurfaceToggle.setAttribute('aria-pressed', 'false')
    const rendererSurfaceRefresh = appendTextElement(
        documentValue,
        rendererSurfaceActions,
        'button',
        'surface-refresh',
        overlayText(locale, 'refreshRendererSurfaces')
    )
    rendererSurfaceRefresh.setAttribute('type', 'button')
    rendererSurfaceRefresh.setAttribute('data-renderer-surface-refresh', '')
    ;(rendererSurfaceRefresh as HTMLButtonElement).disabled = true
    const rendererSurfaceHelp = appendTextElement(
        documentValue,
        rendererSurfacePanel,
        'p',
        'surface-help',
        overlayText(locale, 'rendererSurfaceHelp')
    )
    const rendererSurfaceList = documentValue.createElement('div')
    rendererSurfaceList.className = 'surface-list'
    rendererSurfaceList.setAttribute('data-renderer-surface-list', '')
    rendererSurfacePanel.replaceChildren(rendererSurfaceHeading, rendererSurfaceActions, rendererSurfaceHelp, rendererSurfaceList)
    const targetHeading = documentValue.createElement('div')
    targetHeading.className = 'section-heading'
    const targetHeadingLabel = appendTextElement(documentValue, targetHeading, 'h3', '', overlayText(locale, 'selectedTarget'))
    const targetStateLabel = appendTextElement(documentValue, targetHeading, 'span', 'count', overlayText(locale, 'ready'))
    targetStateLabel.setAttribute('aria-live', 'polite')
    targetStateLabel.setAttribute('aria-atomic', 'true')
    const targetList = documentValue.createElement('div')
    targetList.className = 'target-list'
    targetPane.append(rendererSurfacePanel, targetHeading, targetList)
    const targetDetail = documentValue.createElement('article')
    targetDetail.className = 'detail-pane'
    targetWorkspace.append(targetPane, targetDetail)
    targetPanel.appendChild(targetWorkspace)

    for (const [tab, tabPanel, tabPanelId] of [
        ['overview', overviewPanel, overviewPanelId],
        ['pageEvidence', pageEvidenceTabPanel, pageEvidenceTabPanelId],
        ['interactions', interactionsPanel, interactionsPanelId],
        ['coverage', coveragePanel, coveragePanelId],
        ['target', targetPanel, targetPanelId],
    ] as const) {
        const button = documentValue.createElement('button')
        const tabButtonId = `${tabPanelId}-tab`
        button.className = 'tab'
        button.setAttribute('id', tabButtonId)
        button.setAttribute('type', 'button')
        button.setAttribute('role', 'tab')
        button.setAttribute('data-overlay-tab', tab)
        button.setAttribute('aria-controls', tabPanelId)
        tabPanel.setAttribute('aria-labelledby', tabButtonId)
        button.textContent = overlayTabText(locale, tab)
        tabs.appendChild(button)
        tabButtons.set(tab, button)
        tabPanels.set(tab, tabPanel)
        content.appendChild(tabPanel)
    }

    const footer = documentValue.createElement('footer')
    footer.className = 'panel-footer'
    const footerLocalLabel = appendTextElement(documentValue, footer, 'span', 'local-label', overlayText(locale, 'localView'))
    const footerTiming = appendTextElement(
        documentValue,
        footer,
        'span',
        '',
        overlayText(locale, 'refreshAtLeast', { seconds: refreshIntervalMs / 1_000 })
    )

    panel.append(panelHeader, diagnosis, metricGrid, tabs, content, footer)
    dock.append(trigger, panel)
    shadow.append(style, dock, launcherMoveHelp, panelMoveHelp)
    mountTarget.appendChild(host)

    let destroyed = false
    let expanded = options.initiallyOpen === true
    let timerId: number | undefined
    let issueHistory: readonly OverlayIssueHistoryEntry[] = []
    let currentViewModel: AnimationOverlayViewModel | undefined
    let selectedIssueId: string | undefined
    let renderedIssueId: string | undefined
    let selectedInteractionId: string | undefined
    let renderedInteractionId: string | undefined
    let selectedCoverageFamily: AnimationRumFamily | undefined
    let renderedCoverageFamily: AnimationRumFamily | undefined
    let previousFrameRateSnapshot: AnimationSnapshot | undefined
    let lastSnapshot: AnimationSnapshot | undefined
    let currentPageEvidence: PageEvidenceRead = { status: 'absent' }
    let currentLocalEvidence: LocalEvidenceRead = { status: 'absent' }
    let lastLiveFrameRate: LiveFrameRateResult = { status: 'collecting' }
    let lastPanelSelfTime = overlayText(locale, 'unavailable')
    let unavailableRendered = false
    let targetSelection: AnimationElementSelectionHandle | null = null
    let targetSnapshot: AnimationElementSelectionSnapshot | null = null
    let targetInteraction: InteractionHandle | null = null
    let restorePanelAfterPick = false
    let launcherPosition = restoredPositions.launcher
    let panelPosition = restoredPositions.panel
    let suppressNextPointerClick = false
    let activeDrag:
        | {
              surface: OverlaySurface
              handle: HTMLElement
              pointerId: number
              startClientX: number
              startClientY: number
              startLeft: number
              startTop: number
              width: number
              height: number
              started: boolean
              position?: OverlayNormalizedPosition
          }
        | undefined
    const rendererSurfaceInspector = createRendererSurfaceInspector({ document: documentValue })
    rendererSurfaceInspector.setEnabled(true)
    let rendererSurfaceSnapshot: RendererSurfaceInspectorSnapshot = rendererSurfaceInspector.snapshot()

    const persistViewPreference = (): void => {
        try {
            timerOwner?.localStorage?.setItem(
                OVERLAY_STORAGE_KEY,
                JSON.stringify({
                    tab: activeTab,
                    layout,
                    locale,
                    positions: {
                        version: OVERLAY_POSITION_VERSION,
                        ...(launcherPosition ? { launcher: launcherPosition } : {}),
                        ...(panelPosition ? { panel: panelPosition } : {}),
                    },
                })
            )
        } catch {
            // Storage can be unavailable in privacy modes or sandboxed documents.
        }
    }

    const viewport = (): OverlayViewport => {
        const visualViewport = timerOwner?.visualViewport
        const fallbackWidth = timerOwner?.innerWidth ?? documentValue.documentElement?.clientWidth ?? 0
        const fallbackHeight = timerOwner?.innerHeight ?? documentValue.documentElement?.clientHeight ?? 0
        const width = Number.isFinite(visualViewport?.width) && (visualViewport?.width ?? 0) > 0 ? visualViewport!.width : fallbackWidth
        const height =
            Number.isFinite(visualViewport?.height) && (visualViewport?.height ?? 0) > 0 ? visualViewport!.height : fallbackHeight
        return {
            left: Number.isFinite(visualViewport?.offsetLeft) ? visualViewport!.offsetLeft : 0,
            top: Number.isFinite(visualViewport?.offsetTop) ? visualViewport!.offsetTop : 0,
            width: Number.isFinite(width) && width > 0 ? width : 0,
            height: Number.isFinite(height) && height > 0 ? height : 0,
        }
    }

    const surfaceElement = (surface: OverlaySurface): HTMLElement => (surface === 'launcher' ? dock : panel)
    const surfacePosition = (surface: OverlaySurface): OverlayNormalizedPosition | undefined =>
        surface === 'launcher' ? launcherPosition : panelPosition
    const setSurfacePosition = (surface: OverlaySurface, position: OverlayNormalizedPosition | undefined): void => {
        if (surface === 'launcher') launcherPosition = position
        else panelPosition = position
    }
    const surfaceBounds = (width: number, height: number): { minLeft: number; minTop: number; maxLeft: number; maxTop: number } => {
        const currentViewport = viewport()
        const minLeft = currentViewport.left + OVERLAY_VIEWPORT_MARGIN_PX
        const minTop = currentViewport.top + OVERLAY_VIEWPORT_MARGIN_PX
        return {
            minLeft,
            minTop,
            maxLeft: Math.max(minLeft, currentViewport.left + currentViewport.width - OVERLAY_VIEWPORT_MARGIN_PX - width),
            maxTop: Math.max(minTop, currentViewport.top + currentViewport.height - OVERLAY_VIEWPORT_MARGIN_PX - height),
        }
    }
    const writeSurfacePixels = (
        surface: OverlaySurface,
        requestedLeft: number,
        requestedTop: number,
        dimensions?: { readonly width: number; readonly height: number }
    ): OverlayNormalizedPosition => {
        const element = surfaceElement(surface)
        const rect = dimensions ?? element.getBoundingClientRect()
        const bounds = surfaceBounds(rect.width, rect.height)
        const left = clamp(requestedLeft, bounds.minLeft, bounds.maxLeft)
        const top = clamp(requestedTop, bounds.minTop, bounds.maxTop)
        element.style.left = `${Number(left.toFixed(3))}px`
        element.style.top = `${Number(top.toFixed(3))}px`
        element.style.right = 'auto'
        element.style.bottom = 'auto'
        return {
            xRatio: bounds.maxLeft === bounds.minLeft ? 0 : (left - bounds.minLeft) / (bounds.maxLeft - bounds.minLeft),
            yRatio: bounds.maxTop === bounds.minTop ? 0 : (top - bounds.minTop) / (bounds.maxTop - bounds.minTop),
        }
    }
    const applySurfacePosition = (surface: OverlaySurface): void => {
        const position = surfacePosition(surface)
        if (!position) return
        const element = surfaceElement(surface)
        const rect = element.getBoundingClientRect()
        const bounds = surfaceBounds(rect.width, rect.height)
        writeSurfacePixels(
            surface,
            bounds.minLeft + position.xRatio * (bounds.maxLeft - bounds.minLeft),
            bounds.minTop + position.yRatio * (bounds.maxTop - bounds.minTop)
        )
    }
    const resetSurfacePosition = (surface: OverlaySurface): void => {
        setSurfacePosition(surface, undefined)
        const element = surfaceElement(surface)
        element.style.left = ''
        element.style.top = ''
        element.style.right = ''
        element.style.bottom = ''
        persistViewPreference()
    }
    const updateActiveDrag = (event: PointerEvent): void => {
        const drag = activeDrag
        if (!drag || event.pointerId !== drag.pointerId) return
        const deltaX = event.clientX - drag.startClientX
        const deltaY = event.clientY - drag.startClientY
        if (!drag.started && Math.hypot(deltaX, deltaY) < OVERLAY_DRAG_THRESHOLD_PX) return
        if (!drag.started) {
            drag.started = true
            drag.handle.setAttribute('data-dragging', 'true')
        }
        event.preventDefault()
        drag.position = writeSurfacePixels(drag.surface, drag.startLeft + deltaX, drag.startTop + deltaY, drag)
    }
    const finishActiveDrag = (event: PointerEvent, updateFinalPosition: boolean): void => {
        const drag = activeDrag
        if (!drag || event.pointerId !== drag.pointerId) return
        if (updateFinalPosition) updateActiveDrag(event)
        activeDrag = undefined
        drag.handle.setAttribute('data-dragging', 'false')
        try {
            if (drag.handle.hasPointerCapture?.(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId)
        } catch {
            // Pointer capture is optional in embedded and synthetic documents.
        }
        if (!drag.started || !drag.position) return
        setSurfacePosition(drag.surface, drag.position)
        if (drag.surface === 'launcher') suppressNextPointerClick = true
        persistViewPreference()
    }
    const beginSurfaceDrag = (surface: OverlaySurface, handle: HTMLElement, event: PointerEvent): void => {
        if (destroyed || activeDrag || event.isPrimary === false || event.button !== 0) return
        if ((surface === 'launcher' && expanded) || (surface === 'panel' && !expanded)) return
        if (!Number.isFinite(event.pointerId)) return
        if (surface === 'launcher') suppressNextPointerClick = false
        const rect = surfaceElement(surface).getBoundingClientRect()
        activeDrag = {
            surface,
            handle,
            pointerId: event.pointerId,
            startClientX: event.clientX,
            startClientY: event.clientY,
            startLeft: rect.left,
            startTop: rect.top,
            width: rect.width,
            height: rect.height,
            started: false,
        }
        try {
            handle.setPointerCapture?.(event.pointerId)
        } catch {
            // The pointer can still complete while it remains over the handle.
        }
    }
    const onSurfaceKeyDown = (surface: OverlaySurface, event: KeyboardEvent): void => {
        if (!event.altKey || event.ctrlKey || event.metaKey || event.currentTarget !== event.target) return
        if (event.key === 'Home') {
            event.preventDefault()
            resetSurfacePosition(surface)
            return
        }
        const direction: readonly [number, number] | undefined =
            event.key === 'ArrowUp'
                ? [0, -1]
                : event.key === 'ArrowDown'
                  ? [0, 1]
                  : event.key === 'ArrowLeft'
                    ? [-1, 0]
                    : event.key === 'ArrowRight'
                      ? [1, 0]
                      : undefined
        if (!direction) return
        if ((surface === 'launcher' && expanded) || (surface === 'panel' && !expanded)) return
        event.preventDefault()
        const element = surfaceElement(surface)
        const rect = element.getBoundingClientRect()
        const step = event.shiftKey ? 1 : OVERLAY_KEYBOARD_MOVE_PX
        const position = writeSurfacePixels(surface, rect.left + direction[0] * step, rect.top + direction[1] * step)
        setSurfacePosition(surface, position)
        persistViewPreference()
    }
    const onViewportChange = (): void => {
        applySurfacePosition('launcher')
        applySurfacePosition('panel')
    }

    const syncCollectorState = (state = readCollectorState(source)): void => {
        const label = collectorStateText(locale, state)
        trigger.setAttribute('data-collector-state', state ?? 'idle')
        triggerStateLabel.textContent = label
        productState.textContent = overlayText(locale, 'localOnlyDiagnostics', { state: label })
    }

    const syncLayout = (): void => {
        dock.setAttribute('data-layout', layout)
        layoutButton.setAttribute('aria-pressed', String(layout === 'wide'))
        layoutButton.setAttribute('aria-label', overlayText(locale, layout === 'wide' ? 'useCompact' : 'openWorkbench'))
        layoutButton.setAttribute('title', overlayText(locale, 'toggleWorkbench'))
        layoutButton.textContent = layout === 'wide' ? '⤡' : '⤢'
        applySurfacePosition('panel')
    }

    const setActiveTab = (nextTab: OverlayTab, moveFocus = false): void => {
        activeTab = nextTab
        for (const tab of OVERLAY_TABS) {
            const active = tab === activeTab
            const button = tabButtons.get(tab)
            const tabPanel = tabPanels.get(tab)
            button?.setAttribute('aria-selected', String(active))
            button?.setAttribute('tabindex', active ? '0' : '-1')
            if (tabPanel) {
                tabPanel.hidden = !active
                tabPanel.setAttribute('aria-hidden', String(!active))
            }
        }
        if (moveFocus) tabButtons.get(activeTab)?.focus()
        persistViewPreference()
    }

    const renderOverviewEvidence = (viewModel?: AnimationOverlayViewModel): void => {
        overviewEvidence.replaceChildren()
        overviewEvidence.setAttribute('aria-label', overlayText(locale, 'captureEvidence'))

        const captureCard = documentValue.createElement('article')
        captureCard.className = 'evidence-card'
        captureCard.setAttribute('data-overlay-capture-sufficiency', '')
        captureCard.setAttribute('data-status', viewModel?.captureEvidence.status ?? 'unknown')
        const captureHeader = documentValue.createElement('div')
        captureHeader.className = 'evidence-card-header'
        appendTextElement(documentValue, captureHeader, 'strong', '', overlayText(locale, 'captureEvidence'))
        appendTextElement(
            documentValue,
            captureHeader,
            'span',
            '',
            viewModel?.captureEvidence.statusLabel ?? overlayText(locale, 'unknown')
        )
        captureCard.appendChild(captureHeader)
        const durationGrid = documentValue.createElement('div')
        durationGrid.className = 'evidence-durations'
        const durations: ReadonlyArray<readonly [string, string]> = viewModel
            ? [
                  [overlayText(locale, 'captureForeground'), viewModel.captureEvidence.foregroundDuration],
                  [overlayText(locale, 'captureBackground'), viewModel.captureEvidence.backgroundDuration],
                  ...(viewModel.captureEvidence.otherDuration === null
                      ? []
                      : ([[overlayText(locale, 'captureOther'), viewModel.captureEvidence.otherDuration]] as const)),
              ]
            : [
                  [overlayText(locale, 'captureForeground'), overlayText(locale, 'unknown')],
                  [overlayText(locale, 'captureBackground'), overlayText(locale, 'unknown')],
              ]
        for (const [label, value] of durations) {
            const duration = documentValue.createElement('div')
            duration.className = 'evidence-duration'
            appendTextElement(documentValue, duration, 'span', '', label)
            appendTextElement(documentValue, duration, 'strong', '', value)
            durationGrid.appendChild(duration)
        }
        captureCard.appendChild(durationGrid)
        appendTextElement(
            documentValue,
            captureCard,
            'p',
            'evidence-reasons',
            viewModel
                ? viewModel.captureEvidence.reasons.length > 0
                    ? viewModel.captureEvidence.reasons.join(' · ')
                    : overlayText(locale, 'captureNoBlockingReason')
                : overlayText(locale, 'notObserved')
        )

        const vitalsCard = documentValue.createElement('article')
        vitalsCard.className = 'evidence-card'
        vitalsCard.setAttribute('data-overlay-web-vitals', '')
        const vitalsHeader = documentValue.createElement('div')
        vitalsHeader.className = 'evidence-card-header'
        appendTextElement(documentValue, vitalsHeader, 'strong', '', overlayText(locale, 'latestWebVitals'))
        appendTextElement(
            documentValue,
            vitalsHeader,
            'span',
            '',
            viewModel?.webVitalsScopeLabel ?? overlayText(locale, 'documentLifetimeScope')
        )
        vitalsCard.appendChild(vitalsHeader)
        const vitalsGrid = documentValue.createElement('div')
        vitalsGrid.className = 'vital-grid'
        const webVitals =
            viewModel?.webVitals ??
            (['LCP', 'INP', 'CLS'] as const).map(name => ({
                name,
                value: overlayText(locale, 'unknown'),
                ratingLabel: overlayText(locale, 'notObserved'),
                observed: false,
            }))
        for (const vital of webVitals) {
            const item = documentValue.createElement('div')
            item.className = 'vital-item'
            item.setAttribute('data-web-vital', vital.name)
            item.setAttribute('data-observed', String(vital.observed))
            appendTextElement(documentValue, item, 'span', '', `${vital.name} · ${vital.ratingLabel}`)
            appendTextElement(documentValue, item, 'strong', '', vital.value)
            vitalsGrid.appendChild(item)
        }
        vitalsCard.appendChild(vitalsGrid)
        overviewEvidence.append(captureCard, vitalsCard)
    }

    const renderPageEvidence = (read: PageEvidenceRead): void => {
        const wasVisible = !pageEvidencePanel.hidden
        const scrollTop = pageEvidencePanel.scrollTop
        const scrollLeft = pageEvidencePanel.scrollLeft
        pageEvidencePanel.replaceChildren()
        currentPageEvidence = read
        pageEvidencePanel.hidden = false
        const header = documentValue.createElement('div')
        header.className = 'page-evidence-header'
        appendTextElement(documentValue, header, 'strong', '', overlayText(locale, 'automaticPageEvidence'))
        pageEvidencePanel.appendChild(header)

        if (read.status === 'absent') {
            appendTextElement(
                documentValue,
                pageEvidencePanel,
                'p',
                'page-evidence-boundary',
                overlayText(locale, 'pageEvidenceNotConnected')
            )
            if (wasVisible) {
                pageEvidencePanel.scrollTop = scrollTop
                pageEvidencePanel.scrollLeft = scrollLeft
            }
            return
        }

        if (read.status === 'unavailable') {
            appendTextElement(
                documentValue,
                pageEvidencePanel,
                'p',
                'page-evidence-boundary',
                overlayText(locale, 'pageEvidenceUnavailable')
            )
            if (wasVisible) {
                pageEvidencePanel.scrollTop = scrollTop
                pageEvidencePanel.scrollLeft = scrollLeft
            }
            return
        }

        const evidence = read.snapshot
        appendTextElement(
            documentValue,
            header,
            'span',
            '',
            overlayText(locale, 'pageEvidenceSummary', {
                samples: evidence.sampleCount,
                scopes: evidence.documentScopes.retainedCount,
            })
        )
        if (!evidence.enabled) {
            appendTextElement(documentValue, pageEvidencePanel, 'p', 'page-evidence-boundary', overlayText(locale, 'pageEvidenceDisabled'))
            if (wasVisible) {
                pageEvidencePanel.scrollTop = scrollTop
                pageEvidencePanel.scrollLeft = scrollLeft
            }
            return
        }

        appendTextElement(documentValue, pageEvidencePanel, 'p', 'page-evidence-boundary', overlayText(locale, 'pageEvidenceBoundary'))
        if (evidence.documentScopes.truncated) {
            appendTextElement(
                documentValue,
                pageEvidencePanel,
                'p',
                'page-evidence-boundary',
                overlayText(locale, 'pageEvidenceScopesTruncated')
            )
        }

        const groups = documentValue.createElement('div')
        groups.className = 'page-evidence-groups'
        const group = (heading: string, lines: readonly { text: string; reviewCandidate?: boolean }[]): HTMLElement => {
            const element = documentValue.createElement('section')
            element.className = 'page-evidence-group'
            appendTextElement(documentValue, element, 'h4', '', heading)
            for (const line of lines) {
                const paragraph = appendTextElement(documentValue, element, 'p', '', line.text)
                if (line.reviewCandidate) paragraph.setAttribute('data-review-candidate', 'true')
            }
            return element
        }

        const animations = evidence.animations
        groups.appendChild(
            group(
                overlayText(locale, 'pageEvidenceAnimationsHeading', {
                    status: pageEvidenceStatusText(locale, animations.status),
                }),
                [
                    {
                        text: overlayText(locale, 'pageEvidenceAnimationSummary', {
                            total: animations.current.total,
                            running: animations.current.running,
                            infinite: animations.current.infinite,
                            peak: animations.peakTotal,
                            dropped: animations.current.dropped,
                        }),
                    },
                    {
                        text: overlayText(locale, 'pageEvidenceLifecycleSummary', {
                            start: animations.lifecycle.animationStartCount,
                            end: animations.lifecycle.animationEndCount,
                            cancel: animations.lifecycle.animationCancelCount,
                            run: animations.lifecycle.transitionRunCount,
                            transitionEnd: animations.lifecycle.transitionEndCount,
                            transitionCancel: animations.lifecycle.transitionCancelCount,
                        }),
                    },
                ]
            )
        )

        const media = evidence.media
        groups.appendChild(
            group(overlayText(locale, 'pageEvidenceMediaHeading', { status: pageEvidenceStatusText(locale, media.status) }), [
                {
                    text: overlayText(locale, 'pageEvidenceMediaSummary', {
                        current: media.currentVideoCount,
                        playing: media.playingVideoCount,
                        probes: media.activeProbeCount,
                        supported: media.rvfcSupportedVideoCount,
                        unsupported: media.rvfcUnsupportedVideoCount,
                        dropped: media.droppedVideoCount,
                    }),
                },
            ])
        )

        const renderer = evidence.rendererSurfaces
        groups.appendChild(
            group(
                overlayText(locale, 'pageEvidenceRendererHeading', {
                    status: pageEvidenceStatusText(locale, renderer.status),
                }),
                [
                    {
                        text: overlayText(locale, 'pageEvidenceRendererSummary', {
                            svg: renderer.current.svg,
                            unknown: renderer.current.canvasUnknown,
                            canvas2d: renderer.current.canvas2d,
                            webgl: renderer.current.webgl,
                            webgl2: renderer.current.webgl2,
                            webgpu: renderer.current.webgpu,
                        }),
                    },
                    {
                        text: overlayText(locale, 'pageEvidenceRendererContextSummary', {
                            contexts: renderer.successfulContextObservationCount,
                            lost: renderer.webglContextLostCount,
                            restored: renderer.webglContextRestoredCount,
                            gpu: gpuTimerCapabilityText(locale, renderer.gpuTimingCapability.state),
                        }),
                    },
                ]
            )
        )

        const work = evidence.workAvoidance
        const hasWorkReviewCandidates =
            work.hiddenRunningAnimationReviewSampleCount > 0 ||
            work.hiddenPlayingVideoReviewSampleCount > 0 ||
            work.offscreenRunningAnimationReviewSampleCount > 0 ||
            work.offscreenPlayingVideoReviewSampleCount > 0
        groups.appendChild(
            group(overlayText(locale, 'pageEvidenceWorkHeading', { status: pageEvidenceStatusText(locale, work.status) }), [
                {
                    text: overlayText(locale, 'pageEvidenceWorkSummary', {
                        hiddenAnimations: work.current.hiddenRunningAnimations,
                        hiddenVideos: work.current.hiddenPlayingVideos,
                        offscreenAnimations: work.current.offscreenRunningAnimations,
                        offscreenVideos: work.current.offscreenPlayingVideos,
                    }),
                },
                {
                    text: overlayText(locale, 'pageEvidenceWorkCandidateSummary', {
                        hiddenAnimations: work.hiddenRunningAnimationReviewSampleCount,
                        hiddenVideos: work.hiddenPlayingVideoReviewSampleCount,
                        offscreenAnimations: work.offscreenRunningAnimationReviewSampleCount,
                        offscreenVideos: work.offscreenPlayingVideoReviewSampleCount,
                        duration: gpuTimerCapabilityText(locale, work.workDurationCapability.state),
                    }),
                    reviewCandidate: hasWorkReviewCandidates,
                },
            ])
        )

        const reduced = evidence.reducedMotion
        const preference =
            reduced.preference === null
                ? overlayText(locale, 'pageEvidencePreferenceUnknown')
                : overlayText(locale, reduced.preference ? 'pageEvidencePreferenceReduce' : 'pageEvidencePreferenceNoPreference')
        groups.appendChild(
            group(
                overlayText(locale, 'pageEvidenceReducedHeading', {
                    status: pageEvidenceStatusText(locale, reduced.status),
                }),
                [
                    {
                        text: overlayText(locale, 'pageEvidenceReducedSummary', {
                            preference,
                            running: reduced.current.runningAnimationCandidates,
                            infinite: reduced.current.infiniteAnimationCandidates,
                            videos: reduced.current.playingVideoCandidates,
                            samples: reduced.reviewCandidateSampleCount,
                        }),
                        reviewCandidate: reduced.reviewCandidateSampleCount > 0,
                    },
                ]
            )
        )

        pageEvidencePanel.appendChild(groups)
        if (wasVisible) {
            pageEvidencePanel.scrollTop = scrollTop
            pageEvidencePanel.scrollLeft = scrollLeft
        }
    }

    const localEvidenceValue = (value: number | null, unit: 'ms' | 'bytes' | 'count'): string =>
        value === null ? overlayText(locale, 'unavailable') : formatOverlayMeasurement(value, unit, locale)

    const mediaStageText = (stage: AnimationLocalMediaStageEvidence): string => {
        const stageLabel = overlayText(
            locale,
            stage.stage === 'decode-ready'
                ? 'localEvidenceDecodeReady'
                : stage.stage === 'upload-ready'
                  ? 'localEvidenceUploadReady'
                  : 'localEvidenceFirstVisible'
        )
        return overlayText(locale, 'localEvidenceMediaStageSummary', {
            stage: stageLabel,
            elapsed: localEvidenceValue(stage.elapsedMs, 'ms'),
            duration: localEvidenceValue(stage.durationMs, 'ms'),
            bytes: localEvidenceValue(stage.byteCount, 'bytes'),
            items: localEvidenceValue(stage.itemCount, 'count'),
        })
    }

    const renderLocalEvidence = (read: LocalEvidenceRead): void => {
        const wasVisible = !localEvidencePanel.hidden
        const scrollTop = localEvidencePanel.scrollTop
        const scrollLeft = localEvidencePanel.scrollLeft
        localEvidencePanel.replaceChildren()
        currentLocalEvidence = read
        if (read.status === 'absent') {
            localEvidencePanel.hidden = true
            return
        }
        if (read.status === 'unavailable') {
            localEvidencePanel.hidden = false
            const header = documentValue.createElement('div')
            header.className = 'local-evidence-header'
            appendTextElement(documentValue, header, 'strong', '', overlayText(locale, 'localSemanticEvidence'))
            localEvidencePanel.appendChild(header)
            appendTextElement(
                documentValue,
                localEvidencePanel,
                'p',
                'local-evidence-boundary',
                overlayText(locale, 'localEvidenceUnavailable')
            )
            if (wasVisible) {
                localEvidencePanel.scrollTop = scrollTop
                localEvidencePanel.scrollLeft = scrollLeft
            }
            return
        }
        const evidence = read.snapshot
        const hasEvidence =
            evidence.providerCount > 0 ||
            evidence.rejectedProviderCount > 0 ||
            evidence.droppedProviderCount > 0 ||
            evidence.media.retainedRecordCount > 0 ||
            evidence.media.droppedRecordCount > 0 ||
            evidence.motion.retainedRecordCount > 0 ||
            evidence.motion.droppedRecordCount > 0 ||
            evidence.browserVideoPresentation.retainedRecordCount > 0 ||
            evidence.browserVideoPresentation.droppedRecordCount > 0
        if (!hasEvidence) {
            localEvidencePanel.hidden = true
            return
        }
        localEvidencePanel.hidden = false
        const header = documentValue.createElement('div')
        header.className = 'local-evidence-header'
        appendTextElement(documentValue, header, 'strong', '', overlayText(locale, 'localSemanticEvidence'))
        appendTextElement(
            documentValue,
            header,
            'span',
            '',
            overlayText(locale, 'localEvidenceProviderSummary', {
                providers: evidence.providerCount,
                dropped: evidence.droppedProviderCount,
                rejected: evidence.rejectedProviderCount,
            })
        )
        localEvidencePanel.appendChild(header)
        appendTextElement(documentValue, localEvidencePanel, 'p', 'local-evidence-boundary', overlayText(locale, 'localEvidenceBoundary'))

        const groups = documentValue.createElement('div')
        groups.className = 'local-evidence-groups'
        const mediaGroup = documentValue.createElement('section')
        mediaGroup.className = 'local-evidence-group'
        appendTextElement(
            documentValue,
            mediaGroup,
            'h4',
            '',
            overlayText(locale, 'localEvidenceMediaHeading', {
                retained: evidence.media.retainedRecordCount,
                dropped: evidence.media.droppedRecordCount,
            })
        )
        if (evidence.media.records.length === 0) {
            appendTextElement(documentValue, mediaGroup, 'div', 'local-evidence-empty', overlayText(locale, 'localEvidenceNoMedia'))
        } else {
            for (const attempt of [...evidence.media.records].reverse()) {
                const item = documentValue.createElement('article')
                item.className = 'local-evidence-record'
                appendTextElement(
                    documentValue,
                    item,
                    'strong',
                    '',
                    overlayText(locale, 'localEvidenceMediaAttemptSummary', {
                        kind: attempt.kind,
                        outcome: attempt.outcome,
                        duration: localEvidenceValue(attempt.durationMs, 'ms'),
                    })
                )
                const stages = [attempt.decodeReady, attempt.uploadReady, attempt.firstVisible].filter(
                    (stage): stage is AnimationLocalMediaStageEvidence => stage !== null
                )
                appendTextElement(
                    documentValue,
                    item,
                    'span',
                    '',
                    stages.length > 0 ? stages.map(mediaStageText).join(' · ') : overlayText(locale, 'localEvidenceNoDeclaredStage')
                )
                mediaGroup.appendChild(item)
            }
        }

        const videoPresentationGroup = documentValue.createElement('section')
        videoPresentationGroup.className = 'local-evidence-group'
        appendTextElement(
            documentValue,
            videoPresentationGroup,
            'h4',
            '',
            locale === 'zh-CN'
                ? `浏览器视频呈现回调 · 保留 ${evidence.browserVideoPresentation.retainedRecordCount} · 丢弃 ${evidence.browserVideoPresentation.droppedRecordCount}`
                : `Browser video presentation callbacks · retained ${evidence.browserVideoPresentation.retainedRecordCount} · dropped ${evidence.browserVideoPresentation.droppedRecordCount}`
        )
        if (evidence.browserVideoPresentation.records.length === 0) {
            appendTextElement(
                documentValue,
                videoPresentationGroup,
                'div',
                'local-evidence-empty',
                locale === 'zh-CN' ? '尚无 requestVideoFrameCallback 证据。' : 'No requestVideoFrameCallback evidence yet.'
            )
        } else {
            for (const record of [...evidence.browserVideoPresentation.records].reverse()) {
                const item = documentValue.createElement('article')
                item.className = 'local-evidence-record'
                appendTextElement(
                    documentValue,
                    item,
                    'strong',
                    '',
                    locale === 'zh-CN'
                        ? `呈现回调 ${localEvidenceValue(record.callbackAt, 'ms')}`
                        : `Presentation callback ${localEvidenceValue(record.callbackAt, 'ms')}`
                )
                appendTextElement(
                    documentValue,
                    item,
                    'span',
                    '',
                    locale === 'zh-CN'
                        ? `回调间隔 ${localEvidenceValue(record.callbackIntervalMs, 'ms')} · 预期显示差 ${localEvidenceValue(record.expectedDisplayDeltaMs, 'ms')} · 解码处理 ${localEvidenceValue(record.processingDurationMs, 'ms')} · presentedFrames 增量 ${localEvidenceValue(record.presentedFramesDelta, 'count')}`
                        : `callback interval ${localEvidenceValue(record.callbackIntervalMs, 'ms')} · expected-display delta ${localEvidenceValue(record.expectedDisplayDeltaMs, 'ms')} · decode processing ${localEvidenceValue(record.processingDurationMs, 'ms')} · presentedFrames delta ${localEvidenceValue(record.presentedFramesDelta, 'count')}`
                )
                videoPresentationGroup.appendChild(item)
            }
        }
        appendTextElement(
            documentValue,
            videoPresentationGroup,
            'p',
            'local-evidence-boundary',
            locale === 'zh-CN'
                ? '这是浏览器 requestVideoFrameCallback 回调与其元数据证据。processingDuration 是浏览器报告的解码处理时长；它不证明 GPU 上传完成、物理 scanout 或屏幕真实首像素，也不是 schema 2 中由调用方声明的媒体阶段。'
                : 'This is browser requestVideoFrameCallback and callback-metadata evidence. processingDuration is browser-reported decode processing; it does not prove GPU upload completion, physical scanout, or a real screen first pixel, and it is separate from caller-attested schema 2 media stages.'
        )

        const motionGroup = documentValue.createElement('section')
        motionGroup.className = 'local-evidence-group'
        appendTextElement(
            documentValue,
            motionGroup,
            'h4',
            '',
            overlayText(locale, 'localEvidenceMotionHeading', {
                retained: evidence.motion.retainedRecordCount,
                dropped: evidence.motion.droppedRecordCount,
            })
        )
        if (evidence.motion.records.length === 0) {
            appendTextElement(documentValue, motionGroup, 'div', 'local-evidence-empty', overlayText(locale, 'localEvidenceNoMotion'))
        } else {
            for (const interaction of [...evidence.motion.records].reverse()) {
                const item = documentValue.createElement('article')
                item.className = 'local-evidence-record'
                appendTextElement(
                    documentValue,
                    item,
                    'strong',
                    '',
                    overlayText(locale, 'localEvidenceMotionInteractionSummary', {
                        kind: interaction.kind,
                        outcome: interaction.outcome,
                        duration: localEvidenceValue(interaction.durationMs, 'ms'),
                    })
                )
                appendTextElement(
                    documentValue,
                    item,
                    'span',
                    '',
                    overlayText(locale, 'localEvidenceMotionCheckpointSummary', {
                        before: interaction.before.status,
                        beforeMeasured: interaction.before.measuredSourceCount,
                        beforeConfigured: interaction.before.configuredSourceCount,
                        after: interaction.after.status,
                        afterMeasured: interaction.after.measuredSourceCount,
                        afterConfigured: interaction.after.configuredSourceCount,
                    })
                )
                appendTextElement(
                    documentValue,
                    item,
                    'span',
                    '',
                    overlayText(locale, 'localEvidenceMotionSourceSummary', {
                        gsap: interaction.after.sourceStatus['gsap-ticker'],
                        lenis: interaction.after.sourceStatus['lenis-scroll'],
                        scrollTrigger: interaction.after.sourceStatus['scroll-trigger'],
                    })
                )
                motionGroup.appendChild(item)
            }
        }
        groups.append(videoPresentationGroup, mediaGroup, motionGroup)
        localEvidencePanel.appendChild(groups)
        if (wasVisible) {
            localEvidencePanel.scrollTop = scrollTop
            localEvidencePanel.scrollLeft = scrollLeft
        }
    }

    const renderIssueDetail = (): void => {
        const detailScrollTop = issueDetail.scrollTop
        const detailScrollLeft = issueDetail.scrollLeft
        issueDetail.replaceChildren()
        const selected = issueHistory.find(issue => issue.recommendation.id === selectedIssueId) ?? issueHistory[0]
        const preserveScroll = selected !== undefined && renderedIssueId === selected.recommendation.id
        renderedIssueId = selected?.recommendation.id
        if (!selected) {
            const empty = documentValue.createElement('div')
            empty.className = 'empty'
            appendTextElement(
                documentValue,
                empty,
                'strong',
                '',
                overlayText(locale, currentViewModel?.captureState === 'steady' ? 'noCurrentFinding' : 'gatheringEvidence')
            )
            appendTextElement(
                documentValue,
                empty,
                'span',
                '',
                overlayText(locale, currentViewModel?.captureState === 'steady' ? 'noCurrentFindingHelp' : 'gatheringEvidenceHelp')
            )
            issueDetail.appendChild(empty)
            return
        }

        appendTextElement(
            documentValue,
            issueDetail,
            'div',
            'detail-kicker',
            `${selected.familyLabel} · ${overlayText(locale, selected.active ? 'current' : 'earlier')}`
        )
        appendTextElement(documentValue, issueDetail, 'div', 'detail-title', selected.title)
        appendTextElement(
            documentValue,
            issueDetail,
            'div',
            'detail-meta',
            overlayText(locale, 'confidenceMeta', {
                confidence: selected.confidenceLabel,
                samples: selected.recommendation.metric.samples,
                evidence: selected.evidenceLabel,
            })
        )
        const comparison = documentValue.createElement('div')
        comparison.className = 'comparison'
        const observed = documentValue.createElement('div')
        observed.className = 'comparison-card'
        appendTextElement(documentValue, observed, 'span', '', overlayText(locale, 'observed'))
        appendTextElement(documentValue, observed, 'strong', '', selected.observation)
        const arrow = appendTextElement(documentValue, comparison, 'span', 'comparison-arrow', '→')
        const target = documentValue.createElement('div')
        target.className = 'comparison-card'
        appendTextElement(documentValue, target, 'span', '', overlayText(locale, 'target', { kind: selected.targetKindLabel }))
        appendTextElement(documentValue, target, 'strong', '', selected.target)
        comparison.replaceChildren(observed, arrow, target)
        issueDetail.appendChild(comparison)

        const why = documentValue.createElement('section')
        why.className = 'detail-section'
        appendTextElement(documentValue, why, 'h4', '', selected.metricLabel)
        appendTextElement(documentValue, why, 'p', '', selected.why)
        issueDetail.appendChild(why)
        const actions = documentValue.createElement('section')
        actions.className = 'detail-section'
        appendTextElement(documentValue, actions, 'h4', '', overlayText(locale, 'whatToChange'))
        appendList(documentValue, actions, selected.actions)
        issueDetail.appendChild(actions)
        const verification = documentValue.createElement('section')
        verification.className = 'detail-section verification'
        appendTextElement(documentValue, verification, 'h4', '', overlayText(locale, 'verifyChange'))
        appendList(documentValue, verification, selected.rerunProtocol)
        appendTextElement(documentValue, verification, 'h4', '', overlayText(locale, 'regressionChecks'))
        appendList(documentValue, verification, selected.regressionChecks)
        issueDetail.appendChild(verification)
        if (preserveScroll) {
            issueDetail.scrollTop = detailScrollTop
            issueDetail.scrollLeft = detailScrollLeft
        }
    }

    const renderIssueHistory = (): void => {
        issueList.replaceChildren()
        const activeIssues = issueHistory.filter(issue => issue.active)
        issueCount.textContent = overlayText(locale, 'currentRetained', {
            current: activeIssues.length,
            retained: issueHistory.length,
        })
        if (issueHistory.length === 0) {
            const empty = documentValue.createElement('div')
            empty.className = 'empty'
            appendTextElement(documentValue, empty, 'strong', '', overlayText(locale, 'noMeasuredFinding'))
            appendTextElement(documentValue, empty, 'span', '', overlayText(locale, 'noMeasuredFindingHelp'))
            issueList.appendChild(empty)
            renderIssueDetail()
            return
        }
        if (!selectedIssueId || !issueHistory.some(issue => issue.recommendation.id === selectedIssueId)) {
            selectedIssueId = activeIssues[0]?.recommendation.id ?? issueHistory[0]?.recommendation.id
        }
        for (const issue of issueHistory) {
            const button = documentValue.createElement('button')
            button.className = 'issue-button'
            button.setAttribute('type', 'button')
            button.setAttribute('data-overlay-issue', issue.recommendation.id)
            button.setAttribute('data-severity', issue.severity)
            button.setAttribute('data-active', String(issue.active))
            button.setAttribute('data-selected', String(issue.recommendation.id === selectedIssueId))
            button.setAttribute('aria-pressed', String(issue.recommendation.id === selectedIssueId))
            const top = documentValue.createElement('span')
            top.className = 'issue-top'
            const titleWrap = documentValue.createElement('span')
            titleWrap.className = 'title-with-dot'
            appendTextElement(documentValue, titleWrap, 'span', 'severity', '')
            appendTextElement(documentValue, titleWrap, 'span', 'issue-title', issue.title)
            const severityLabel =
                issue.severity === 'critical'
                    ? overlayText(locale, 'severityCritical')
                    : issue.severity === 'warning'
                      ? overlayText(locale, 'severityWarning')
                      : overlayText(locale, 'severityInfo')
            const issueState = appendTextElement(
                documentValue,
                top,
                'span',
                'count',
                issue.active ? severityLabel : overlayText(locale, 'earlier')
            )
            top.replaceChildren(titleWrap, issueState)
            const meta = documentValue.createElement('span')
            meta.className = 'issue-meta'
            appendTextElement(documentValue, meta, 'span', '', `${issue.observation} → ${issue.target}`)
            appendTextElement(documentValue, meta, 'span', '', issue.confidenceLabel)
            button.append(top, meta)
            button.addEventListener('click', () => {
                selectedIssueId = issue.recommendation.id
                renderIssueHistory()
            })
            issueList.appendChild(button)
        }
        renderIssueDetail()
    }

    const renderInteractionDetail = (interactions: readonly OverlayInteractionView[]): void => {
        const detailScrollTop = interactionDetail.scrollTop
        const detailScrollLeft = interactionDetail.scrollLeft
        interactionDetail.replaceChildren()
        const selected = interactions.find(item => item.measurement.id === selectedInteractionId) ?? interactions[0]
        const preserveScroll = selected !== undefined && renderedInteractionId === selected.measurement.id
        renderedInteractionId = selected?.measurement.id
        if (!selected) {
            const empty = documentValue.createElement('div')
            empty.className = 'empty'
            appendTextElement(documentValue, empty, 'strong', '', overlayText(locale, 'noCompletedInteraction'))
            appendTextElement(documentValue, empty, 'span', '', overlayText(locale, 'noCompletedInteractionHelp'))
            interactionDetail.appendChild(empty)
            return
        }
        appendTextElement(documentValue, interactionDetail, 'div', 'detail-kicker', `${selected.kindLabel} · ${selected.outcomeLabel}`)
        appendTextElement(documentValue, interactionDetail, 'div', 'detail-title', selected.title)
        appendTextElement(
            documentValue,
            interactionDetail,
            'div',
            'detail-meta',
            overlayText(locale, 'interaction', { id: selected.measurement.id })
        )
        const facts = documentValue.createElement('div')
        facts.className = 'interaction-facts'
        const factsToRender: ReadonlyArray<readonly [string, string]> = [
            [overlayText(locale, 'duration'), selected.duration],
            [overlayText(locale, 'frameP95'), selected.frameTail],
            [overlayText(locale, 'slowFrames'), String(selected.measurement.performance.frames.slowFrameCount)],
            [overlayText(locale, 'missedDisplays'), String(selected.measurement.performance.frames.missedFrameOpportunities)],
        ]
        for (const [label, value] of factsToRender) {
            const fact = documentValue.createElement('div')
            fact.className = 'fact'
            appendTextElement(documentValue, fact, 'span', '', label)
            appendTextElement(documentValue, fact, 'strong', '', value)
            facts.appendChild(fact)
        }
        interactionDetail.appendChild(facts)
        const signals = documentValue.createElement('section')
        signals.className = 'detail-section'
        appendTextElement(documentValue, signals, 'h4', '', overlayText(locale, 'overlappingSignals'))
        appendTextElement(documentValue, signals, 'p', '', selected.signalSummary)
        interactionDetail.appendChild(signals)
        if (selected.inputFrameScheduling) {
            const scheduling = documentValue.createElement('section')
            scheduling.className = 'detail-section'
            scheduling.setAttribute('data-input-frame-scheduling', selected.measurement.id)
            appendTextElement(documentValue, scheduling, 'h4', '', overlayText(locale, 'inputFrameScheduling'))
            appendTextElement(
                documentValue,
                scheduling,
                'p',
                '',
                `${selected.inputFrameScheduling.value} · ${selected.inputFrameScheduling.statusLabel}`
            )
            appendTextElement(documentValue, scheduling, 'p', '', selected.inputFrameScheduling.evidence)
            appendTextElement(documentValue, scheduling, 'p', '', overlayText(locale, 'inputFrameSchedulingBoundary'))
            interactionDetail.appendChild(scheduling)
        }
        if (selected.qualityFacts.length > 0) {
            const quality = documentValue.createElement('section')
            quality.className = 'detail-section'
            quality.setAttribute('data-interaction-quality', selected.measurement.id)
            appendTextElement(documentValue, quality, 'h4', '', overlayText(locale, 'interactionQuality'))
            const qualityFacts = documentValue.createElement('div')
            qualityFacts.className = 'interaction-facts'
            for (const evidence of selected.qualityFacts) {
                const fact = documentValue.createElement('div')
                fact.className = 'fact'
                fact.setAttribute('data-interaction-quality-metric', evidence.id)
                appendTextElement(documentValue, fact, 'span', '', evidence.label)
                appendTextElement(documentValue, fact, 'strong', '', evidence.value)
                qualityFacts.appendChild(fact)
            }
            quality.appendChild(qualityFacts)
            interactionDetail.appendChild(quality)
        }
        const boundary = documentValue.createElement('section')
        boundary.className = 'detail-section verification'
        appendTextElement(documentValue, boundary, 'h4', '', overlayText(locale, 'interpretationBoundary'))
        appendTextElement(documentValue, boundary, 'p', '', overlayText(locale, 'interactionBoundary'))
        interactionDetail.appendChild(boundary)
        if (preserveScroll) {
            interactionDetail.scrollTop = detailScrollTop
            interactionDetail.scrollLeft = detailScrollLeft
        }
    }

    const renderInteractions = (interactions: readonly OverlayInteractionView[]): void => {
        interactionList.replaceChildren()
        interactionCount.textContent = overlayText(locale, 'retained', { count: interactions.length })
        if (!selectedInteractionId || !interactions.some(item => item.measurement.id === selectedInteractionId)) {
            selectedInteractionId = interactions[0]?.measurement.id
        }
        if (interactions.length === 0) {
            const empty = documentValue.createElement('div')
            empty.className = 'empty'
            appendTextElement(documentValue, empty, 'strong', '', overlayText(locale, 'noInteractionHistory'))
            appendTextElement(documentValue, empty, 'span', '', overlayText(locale, 'noInteractionHistoryHelp'))
            interactionList.appendChild(empty)
        } else {
            for (const interaction of interactions) {
                const button = documentValue.createElement('button')
                button.className = 'interaction-button'
                button.setAttribute('type', 'button')
                button.setAttribute('data-overlay-interaction', interaction.measurement.id)
                button.setAttribute('data-status', interaction.status)
                button.setAttribute('data-selected', String(interaction.measurement.id === selectedInteractionId))
                button.setAttribute('aria-pressed', String(interaction.measurement.id === selectedInteractionId))
                const top = documentValue.createElement('span')
                top.className = 'interaction-top'
                const titleWrap = documentValue.createElement('span')
                titleWrap.className = 'title-with-dot'
                appendTextElement(documentValue, titleWrap, 'span', 'severity', '')
                appendTextElement(documentValue, titleWrap, 'span', 'interaction-title', interaction.title)
                const outcome = appendTextElement(documentValue, top, 'span', 'count', interaction.outcomeLabel)
                top.replaceChildren(titleWrap, outcome)
                const meta = documentValue.createElement('span')
                meta.className = 'interaction-meta'
                appendTextElement(documentValue, meta, 'span', '', `${interaction.kindLabel} · ${interaction.duration}`)
                appendTextElement(documentValue, meta, 'span', '', `${overlayText(locale, 'frameP95')} ${interaction.frameTail}`)
                button.append(top, meta)
                button.addEventListener('click', () => {
                    selectedInteractionId = interaction.measurement.id
                    renderInteractions(interactions)
                })
                interactionList.appendChild(button)
            }
        }
        renderInteractionDetail(interactions)
    }

    const appendHostEvidenceFact = (
        parent: HTMLElement,
        family: 'renderer' | 'media' | 'lifecycle' | 'work',
        id: string,
        label: string,
        value: string
    ): void => {
        const fact = documentValue.createElement('div')
        fact.className = 'fact'
        fact.setAttribute('data-host-evidence-family', family)
        fact.setAttribute('data-host-evidence-metric', id)
        appendTextElement(documentValue, fact, 'span', '', label)
        appendTextElement(documentValue, fact, 'strong', '', value)
        parent.appendChild(fact)
    }

    const hostFamilyAttempted = (summary: { acceptedSampleCount: number; rejectedSampleCount: number } | undefined): boolean =>
        Boolean(summary && (summary.acceptedSampleCount > 0 || summary.rejectedSampleCount > 0))

    const hostFamilyAccepted = (summary: { acceptedSampleCount: number } | undefined): boolean =>
        Boolean(summary && summary.acceptedSampleCount > 0)

    const formatKnownHostCount = (value: number | null | undefined, known: boolean): string =>
        formatOverlayMeasurement(known ? value : null, 'count', locale)

    const appendHostEvidenceBoundary = (section: HTMLElement): void => {
        appendTextElement(documentValue, section, 'p', 'coverage-note', overlayText(locale, 'hostEvidenceBoundary'))
    }

    const renderRendererHostEvidenceDetail = (): void => {
        const renderer = lastSnapshot?.hostEvidence?.renderer
        const attempted = hostFamilyAttempted(renderer)
        const section = documentValue.createElement('section')
        section.className = 'detail-section'
        section.setAttribute('data-host-evidence', 'renderer')
        appendTextElement(documentValue, section, 'h4', '', overlayText(locale, 'rendererHostEvidence'))
        appendTextElement(documentValue, section, 'p', 'coverage-note', overlayText(locale, 'hostEvidenceScope'))
        const facts = documentValue.createElement('div')
        facts.className = 'resource-facts'
        const knownBackends = hostFamilyAccepted(renderer)
            ? renderer?.backends
                  .filter(backend => backend !== 'unknown')
                  .map(backend =>
                      backend === 'canvas2d' ? 'Canvas 2D' : backend === 'webgl' ? 'WebGL' : backend === 'webgl2' ? 'WebGL 2' : 'WebGPU'
                  )
            : undefined
        appendHostEvidenceFact(
            facts,
            'renderer',
            'backend',
            overlayText(locale, 'rendererBackend'),
            knownBackends && knownBackends.length > 0 ? knownBackends.join(' · ') : overlayText(locale, 'unknown')
        )
        appendHostEvidenceFact(
            facts,
            'renderer',
            'draw-calls-p95',
            overlayText(locale, 'rendererDrawCallsP95'),
            formatOverlayMeasurement(renderer?.drawCalls?.p95, 'count', locale)
        )
        appendHostEvidenceFact(
            facts,
            'renderer',
            'triangles-p95',
            overlayText(locale, 'rendererTrianglesP95'),
            formatOverlayMeasurement(renderer?.triangles?.p95, 'count', locale)
        )
        appendHostEvidenceFact(
            facts,
            'renderer',
            'lines-p95',
            overlayText(locale, 'rendererLinesP95'),
            formatOverlayMeasurement(renderer?.lines?.p95, 'count', locale)
        )
        appendHostEvidenceFact(
            facts,
            'renderer',
            'points-p95',
            overlayText(locale, 'rendererPointsP95'),
            formatOverlayMeasurement(renderer?.points?.p95, 'count', locale)
        )
        appendHostEvidenceFact(
            facts,
            'renderer',
            'geometries-p95',
            overlayText(locale, 'rendererGeometriesP95'),
            formatOverlayMeasurement(renderer?.geometries?.p95, 'count', locale)
        )
        appendHostEvidenceFact(
            facts,
            'renderer',
            'textures-p95',
            overlayText(locale, 'rendererTexturesP95'),
            formatOverlayMeasurement(renderer?.textures?.p95, 'count', locale)
        )
        appendHostEvidenceFact(
            facts,
            'renderer',
            'programs-p95',
            overlayText(locale, 'rendererProgramsP95'),
            formatOverlayMeasurement(renderer?.programs?.p95, 'count', locale)
        )
        appendHostEvidenceFact(
            facts,
            'renderer',
            'gpu-timer-capability',
            overlayText(locale, 'rendererGpuTimerCapability'),
            gpuTimerCapabilityText(locale, rendererGpuTimerCapability(renderer))
        )
        appendHostEvidenceFact(
            facts,
            'renderer',
            'gpu-frame-p95',
            overlayText(locale, 'rendererGpuFrameP95'),
            formatOverlayMeasurement(renderer?.gpuFrameMs?.p95, 'ms', locale)
        )
        appendHostEvidenceFact(
            facts,
            'renderer',
            'gpu-rejected',
            overlayText(locale, 'rendererGpuRejectedSamples'),
            formatKnownHostCount(renderer?.gpuRejectedSampleCount, hostFamilyAccepted(renderer))
        )
        appendHostEvidenceFact(
            facts,
            'renderer',
            'retained-tail',
            overlayText(locale, 'rendererTailState'),
            hostFamilyAccepted(renderer)
                ? overlayText(locale, renderer?.truncated ? 'rendererTailTruncated' : 'rendererTailComplete')
                : overlayText(locale, 'unknown')
        )
        appendHostEvidenceFact(
            facts,
            'renderer',
            'accepted',
            overlayText(locale, 'hostAcceptedSamples'),
            formatKnownHostCount(renderer?.acceptedSampleCount, attempted)
        )
        appendHostEvidenceFact(
            facts,
            'renderer',
            'dropped',
            overlayText(locale, 'hostDroppedSamples'),
            formatKnownHostCount(renderer?.droppedSampleCount, attempted)
        )
        appendHostEvidenceFact(
            facts,
            'renderer',
            'rejected',
            overlayText(locale, 'hostRejectedSamples'),
            formatKnownHostCount(renderer?.rejectedSampleCount, attempted)
        )
        section.appendChild(facts)
        appendHostEvidenceBoundary(section)
        coverageDetail.appendChild(section)
    }

    const renderMediaHostEvidenceDetail = (): void => {
        const media = lastSnapshot?.hostEvidence?.media
        const playbackQualityKnown = hostFamilyAccepted(media) && (media?.playbackQualityMeasuredSampleCount ?? 0) > 0
        const section = documentValue.createElement('section')
        section.className = 'detail-section'
        section.setAttribute('data-host-evidence', 'media')
        appendTextElement(documentValue, section, 'h4', '', overlayText(locale, 'mediaHostEvidence'))
        appendTextElement(documentValue, section, 'p', 'coverage-note', overlayText(locale, 'hostEvidenceScope'))
        const facts = documentValue.createElement('div')
        facts.className = 'resource-facts'
        appendHostEvidenceFact(
            facts,
            'media',
            'callback-p95',
            overlayText(locale, 'mediaCallbackP95'),
            formatOverlayMeasurement(media?.callbackIntervalMs?.p95, 'ms', locale)
        )
        appendHostEvidenceFact(
            facts,
            'media',
            'presented-frames-delta-p95',
            overlayText(locale, 'mediaPresentedFramesDeltaP95'),
            formatOverlayMeasurement(media?.presentedFramesDelta?.p95, 'count', locale)
        )
        appendHostEvidenceFact(
            facts,
            'media',
            'dropped-video-frames',
            overlayText(locale, 'mediaDroppedFrames'),
            formatKnownHostCount(media?.droppedVideoFramesDelta, playbackQualityKnown)
        )
        appendHostEvidenceFact(
            facts,
            'media',
            'total-video-frames',
            overlayText(locale, 'mediaTotalFrames'),
            formatKnownHostCount(media?.totalVideoFramesDelta, playbackQualityKnown)
        )
        appendHostEvidenceFact(
            facts,
            'media',
            'playback-drop-ratio',
            overlayText(locale, 'mediaDropRatio'),
            formatOverlayMeasurement(playbackQualityKnown ? media?.playbackDropRatio : null, 'ratio', locale)
        )
        section.appendChild(facts)
        appendTextElement(documentValue, section, 'p', 'coverage-note', overlayText(locale, 'mediaBoundary'))
        appendHostEvidenceBoundary(section)
        coverageDetail.appendChild(section)
    }

    const renderLifecycleHostEvidenceDetail = (): void => {
        const lifecycle = lastSnapshot?.hostEvidence?.lifecycle
        const checkpoints = lifecycle?.checkpoints
        const section = documentValue.createElement('section')
        section.className = 'detail-section'
        section.setAttribute('data-host-evidence', 'lifecycle')
        appendTextElement(documentValue, section, 'h4', '', overlayText(locale, 'lifecycleHostEvidence'))
        appendTextElement(documentValue, section, 'p', 'coverage-note', overlayText(locale, 'hostEvidenceScope'))
        const facts = documentValue.createElement('div')
        facts.className = 'resource-facts'
        appendHostEvidenceFact(
            facts,
            'lifecycle',
            'animations',
            overlayText(locale, 'lifecycleAnimations'),
            formatOverlayMeasurement(lifecycle?.latestAnimationTotal, 'count', locale)
        )
        appendHostEvidenceFact(
            facts,
            'lifecycle',
            'active-animations',
            overlayText(locale, 'lifecycleActiveAnimations'),
            formatOverlayMeasurement(lifecycle?.latestActiveAnimationCount, 'count', locale)
        )
        appendHostEvidenceFact(
            facts,
            'lifecycle',
            'scroll-triggers',
            overlayText(locale, 'lifecycleScrollTriggers'),
            formatOverlayMeasurement(lifecycle?.latestScrollTriggerTotal, 'count', locale)
        )
        appendHostEvidenceFact(
            facts,
            'lifecycle',
            'checkpoints',
            overlayText(locale, 'lifecycleCheckpoints'),
            hostFamilyAccepted(lifecycle) && checkpoints
                ? overlayText(locale, 'lifecycleCheckpointSummary', {
                      mount: checkpoints.mount,
                      interaction: checkpoints['after-interaction'],
                      unmount: checkpoints.unmount,
                      manual: checkpoints.manual,
                  })
                : overlayText(locale, 'unknown')
        )
        section.appendChild(facts)
        appendTextElement(documentValue, section, 'p', 'coverage-note', overlayText(locale, 'lifecycleLeakUnknown'))
        appendHostEvidenceBoundary(section)
        coverageDetail.appendChild(section)
    }

    const renderWorkHostEvidenceDetail = (): void => {
        const framework = lastSnapshot?.hostEvidence?.framework
        const work = lastSnapshot?.hostEvidence?.work
        const workAttempted = hostFamilyAttempted(work)
        const categories = work?.categories
        const section = documentValue.createElement('section')
        section.className = 'detail-section'
        section.setAttribute('data-host-evidence', 'work')
        appendTextElement(documentValue, section, 'h4', '', overlayText(locale, 'workHostEvidence'))
        appendTextElement(documentValue, section, 'p', 'coverage-note', overlayText(locale, 'hostEvidenceScope'))
        const facts = documentValue.createElement('div')
        facts.className = 'resource-facts'
        appendHostEvidenceFact(
            facts,
            'work',
            'framework-render-p95',
            overlayText(locale, 'frameworkRenderP95'),
            formatOverlayMeasurement(framework?.renderMs?.p95, 'ms', locale)
        )
        appendHostEvidenceFact(
            facts,
            'work',
            'framework-commit-p95',
            overlayText(locale, 'frameworkCommitP95'),
            formatOverlayMeasurement(framework?.commitMs?.p95, 'ms', locale)
        )
        appendHostEvidenceFact(
            facts,
            'work',
            'framework-update-window-p95',
            overlayText(locale, 'frameworkUpdateWindowP95'),
            formatOverlayMeasurement(framework?.updateWindowMs?.p95, 'ms', locale)
        )
        appendHostEvidenceFact(
            facts,
            'work',
            'framework-check-window-p95',
            overlayText(locale, 'frameworkCheckWindowP95'),
            formatOverlayMeasurement(framework?.checkWindowMs?.p95, 'ms', locale)
        )
        appendHostEvidenceFact(
            facts,
            'work',
            'total-work-samples',
            overlayText(locale, 'workTotalSamples'),
            formatKnownHostCount(work?.acceptedSampleCount, workAttempted)
        )
        appendHostEvidenceFact(
            facts,
            'work',
            'work-categories',
            overlayText(locale, 'workCategories'),
            hostFamilyAccepted(work) && categories ? overlayText(locale, 'workCategorySummary', categories) : overlayText(locale, 'unknown')
        )
        section.appendChild(facts)
        appendTextElement(documentValue, section, 'p', 'coverage-note', overlayText(locale, 'workAvoidanceUnknown'))
        appendHostEvidenceBoundary(section)
        coverageDetail.appendChild(section)
    }

    const renderResourceTimingDetail = (): void => {
        const resourceTiming = lastSnapshot?.resourceTiming
        const section = documentValue.createElement('section')
        section.className = 'detail-section'
        section.setAttribute('data-resource-timing', '')
        appendTextElement(documentValue, section, 'h4', '', overlayText(locale, 'resourceTimingEvidence'))
        appendTextElement(documentValue, section, 'p', 'coverage-note', overlayText(locale, 'resourceTimingScope'))

        const facts = documentValue.createElement('div')
        facts.className = 'resource-facts'
        const values = [
            ['total-observed', 'resourceCount', resourceTiming?.totalObservedCount, 'count'],
            ['retained', 'resourceRetained', resourceTiming?.retainedCount, 'count'],
            ['dropped', 'resourceDropped', resourceTiming?.droppedSampleCount, 'count'],
            ['rejected', 'resourceRejected', resourceTiming?.rejectedEntryCount, 'count'],
            ['excluded-pre-capture', 'resourceExcludedPreCapture', resourceTiming?.excludedPreCaptureCount, 'count'],
            ['duration-p95', 'resourceDurationP95', resourceTiming?.duration?.p95, 'ms'],
            ['transfer-bytes', 'resourceTransferBytes', resourceTiming?.transferSizeBytes, 'bytes'],
            ['encoded-bytes', 'resourceEncodedBytes', resourceTiming?.encodedBodySizeBytes, 'bytes'],
            ['decoded-bytes', 'resourceDecodedBytes', resourceTiming?.decodedBodySizeBytes, 'bytes'],
            ['zero-transfer', 'resourceZeroTransfer', resourceTiming?.zeroTransferSizeCount, 'count'],
            ['buffer-full', 'resourceBufferFull', resourceTiming?.bufferFullEventCount, 'count'],
        ] as const
        for (const [id, labelKey, value, unit] of values) {
            const fact = documentValue.createElement('div')
            fact.className = 'fact'
            fact.setAttribute('data-resource-timing-metric', id)
            appendTextElement(documentValue, fact, 'span', '', overlayText(locale, labelKey))
            appendTextElement(documentValue, fact, 'strong', '', formatOverlayMeasurement(value, unit, locale))
            facts.appendChild(fact)
        }
        section.appendChild(facts)

        appendTextElement(documentValue, section, 'h4', '', overlayText(locale, 'resourceCategories'))
        const categories = documentValue.createElement('div')
        categories.className = 'resource-category-grid'
        for (const category of Object.keys(RESOURCE_CATEGORY_LABEL_KEYS) as Array<keyof typeof RESOURCE_CATEGORY_LABEL_KEYS>) {
            const summary = resourceTiming?.categories?.[category]
            const card = documentValue.createElement('div')
            card.className = 'resource-category'
            card.setAttribute('data-resource-category', category)
            appendTextElement(documentValue, card, 'strong', '', overlayText(locale, RESOURCE_CATEGORY_LABEL_KEYS[category]))
            appendTextElement(
                documentValue,
                card,
                'span',
                '',
                overlayText(locale, 'resourceCategorySummary', {
                    count: formatOverlayMeasurement(summary?.totalObservedCount, 'count', locale),
                    duration: formatOverlayMeasurement(summary?.duration?.p95, 'ms', locale),
                    bytes: formatOverlayMeasurement(summary?.transferSizeBytes, 'bytes', locale),
                })
            )
            categories.appendChild(card)
        }
        section.appendChild(categories)
        appendTextElement(documentValue, section, 'p', 'coverage-note', overlayText(locale, 'resourceTimingBoundary'))
        coverageDetail.appendChild(section)
    }

    const renderCoverageDetail = (viewModel: AnimationOverlayViewModel): void => {
        const detailScrollTop = coverageDetail.scrollTop
        const detailScrollLeft = coverageDetail.scrollLeft
        coverageDetail.replaceChildren()
        const selected = viewModel.coverage.find(item => item.family === selectedCoverageFamily) ?? viewModel.coverage[0]
        const preserveScroll = selected !== undefined && renderedCoverageFamily === selected.family
        renderedCoverageFamily = selected?.family
        if (!selected) {
            const empty = documentValue.createElement('div')
            empty.className = 'empty'
            appendTextElement(documentValue, empty, 'strong', '', overlayText(locale, 'metricCoverage'))
            appendTextElement(documentValue, empty, 'span', '', overlayText(locale, 'coverageNote'))
            coverageDetail.appendChild(empty)
            return
        }
        appendTextElement(documentValue, coverageDetail, 'div', 'detail-kicker', selected.evidenceLabel)
        appendTextElement(documentValue, coverageDetail, 'div', 'detail-title', selected.label)
        appendTextElement(documentValue, coverageDetail, 'div', 'detail-meta', selected.statusLabel)
        if (selected.family === 'renderer') renderRendererHostEvidenceDetail()
        if (selected.family === 'resourcesMedia') {
            renderResourceTimingDetail()
            renderMediaHostEvidenceDetail()
        }
        if (selected.family === 'memoryLifecycle') renderLifecycleHostEvidenceDetail()
        if (selected.family === 'workAvoidance') renderWorkHostEvidenceDetail()
        const meaning = documentValue.createElement('section')
        meaning.className = 'detail-section'
        appendTextElement(documentValue, meaning, 'h4', '', overlayText(locale, 'coverageMeaning'))
        appendTextElement(documentValue, meaning, 'p', '', selected.meaning)
        coverageDetail.appendChild(meaning)
        const boundary = documentValue.createElement('section')
        boundary.className = 'detail-section verification'
        appendTextElement(documentValue, boundary, 'h4', '', overlayText(locale, 'interpretationBoundary'))
        appendTextElement(documentValue, boundary, 'p', 'coverage-note', overlayText(locale, 'coverageBoundary'))
        coverageDetail.appendChild(boundary)
        if (preserveScroll) {
            coverageDetail.scrollTop = detailScrollTop
            coverageDetail.scrollLeft = detailScrollLeft
        }
    }

    const renderCoverage = (viewModel: AnimationOverlayViewModel): void => {
        coverageGrid.replaceChildren()
        coverageCount.textContent = overlayText(locale, 'coverageCount', { count: viewModel.coverage.length })
        if (!selectedCoverageFamily || !viewModel.coverage.some(item => item.family === selectedCoverageFamily)) {
            selectedCoverageFamily = viewModel.coverage[0]?.family
        }
        for (const coverage of viewModel.coverage) {
            const button = documentValue.createElement('button')
            button.className = 'coverage-button'
            button.setAttribute('type', 'button')
            button.setAttribute('data-coverage-family', coverage.family)
            button.setAttribute('data-status', coverage.status)
            button.setAttribute('data-selected', String(coverage.family === selectedCoverageFamily))
            button.setAttribute('aria-pressed', String(coverage.family === selectedCoverageFamily))
            appendTextElement(documentValue, button, 'strong', '', coverage.label)
            appendTextElement(documentValue, button, 'span', 'coverage-status', coverage.statusLabel)
            appendTextElement(documentValue, button, 'small', '', coverage.evidenceLabel)
            button.addEventListener('click', () => {
                selectedCoverageFamily = coverage.family
                renderCoverage(viewModel)
            })
            coverageGrid.appendChild(button)
        }
        renderCoverageDetail(viewModel)
    }

    const cancelTargetInteraction = (): void => {
        const interaction = targetInteraction
        if (!interaction) return
        try {
            interaction.cancel()
        } catch {
            // Selection cleanup below still gets a chance to cancel its active interaction.
        } finally {
            targetInteraction = null
        }
    }

    const clearTarget = (): void => {
        const selection = targetSelection
        cancelTargetInteraction()
        try {
            selection?.clear()
        } catch {
            // Clearing the local overlay must not alter or stop the page collector.
        }
        targetSelection = null
        targetSnapshot = null
        rendererSurfaceInspector.select(null)
        renderTarget(lastSnapshot)
        renderRendererSurfaces()
    }

    const selectElementAsTarget = (element: Element, rendererSurfaceId?: string): void => {
        clearTarget()
        if (rendererSurfaceId) rendererSurfaceInspector.select(rendererSurfaceId)
        try {
            targetSelection =
                source.selectElement?.(element, {
                    mode: options.targetSelectionMode ?? 'subtree',
                    adapters: options.targetAdapters,
                    inspectionPurpose: 'local',
                }) ?? null
            targetSnapshot = targetSelection?.snapshot() ?? null
        } catch {
            targetSelection = null
            targetSnapshot = null
        }
        setActiveTab('target')
        setExpanded(true)
        renderRendererSurfaces()
        renderTarget(lastSnapshot)
    }

    const startTargetRecording = (): void => {
        const selection = targetSelection
        if (!selection || targetInteraction || selection.state === 'cleared' || selection.state === 'disconnected') return
        try {
            targetInteraction = selection.beginInteraction('custom', 'selected target window')
        } catch {
            // Direct element evidence remains useful if the page collector stopped.
        }
        renderTarget(lastSnapshot)
    }

    const stopTargetRecording = (): void => {
        const interaction = targetInteraction
        if (!interaction) return
        try {
            interaction.end()
            targetInteraction = null
        } catch {
            // Keep the handle so the developer can retry Stop or Clear the target.
        }
        renderTarget(lastSnapshot)
    }

    const resetTargetRecording = (): void => {
        const interaction = targetInteraction
        if (interaction) {
            try {
                interaction.cancel()
                targetInteraction = null
            } catch {
                // Do not overlap a fresh window with one that could not be cancelled.
                renderTarget(lastSnapshot)
                return
            }
        }
        startTargetRecording()
    }

    const targetWindow = (
        pageSnapshot: AnimationSnapshot | undefined,
        selected: AnimationElementSelectionSnapshot
    ): InteractionPerformanceSummary | null => {
        const interactionId = selected.activeInteractionId
        if (interactionId && pageSnapshot) {
            const active = pageSnapshot.interactions.active.find(interaction => interaction.id === interactionId)
            if (active) return active.performance
            const recent = pageSnapshot.interactions.recent.find(interaction => interaction.id === interactionId)
            if (recent) return recent.performance
        }
        return selected.correlated
    }

    const appendTargetFact = (parent: Node, labelText: string, value: string): void => {
        const fact = documentValue.createElement('div')
        fact.className = 'fact'
        appendTextElement(documentValue, fact, 'span', '', labelText)
        appendTextElement(documentValue, fact, 'strong', '', value)
        parent.appendChild(fact)
    }

    function renderRendererSurfaces(refreshDiscovery = false): void {
        if (refreshDiscovery && rendererSurfaceInspector.enabled) rendererSurfaceSnapshot = rendererSurfaceInspector.refresh()
        else rendererSurfaceSnapshot = rendererSurfaceInspector.snapshot()
        const enabled = rendererSurfaceSnapshot.enabled
        rendererSurfaceToggle.setAttribute('data-enabled', String(enabled))
        rendererSurfaceToggle.setAttribute('aria-pressed', String(enabled))
        rendererSurfaceToggle.textContent = overlayText(locale, enabled ? 'hideRendererSurfaces' : 'showRendererSurfaces')
        rendererSurfaceToggle.setAttribute(
            'title',
            overlayText(locale, enabled ? 'hideRendererSurfacesTitle' : 'showRendererSurfacesTitle')
        )
        ;(rendererSurfaceRefresh as HTMLButtonElement).disabled = !enabled
        rendererSurfaceRefresh.textContent = overlayText(locale, 'refreshRendererSurfaces')
        rendererSurfaceCount.textContent = overlayText(locale, 'rendererSurfaceCount', {
            count: rendererSurfaceSnapshot.retainedCount,
        })
        rendererSurfaceHelp.textContent = overlayText(
            locale,
            !enabled
                ? 'rendererSurfaceHelp'
                : rendererSurfaceSnapshot.outlineStatus === 'paused-hidden'
                  ? 'rendererSurfacePausedHidden'
                  : rendererSurfaceSnapshot.outlineStatus === 'unsupported'
                    ? 'rendererSurfaceOutlineUnsupported'
                    : rendererSurfaceSnapshot.truncated
                      ? 'rendererSurfaceTruncated'
                      : 'rendererSurfacePrivacy'
        )
        rendererSurfaceList.replaceChildren()
        if (!enabled) return
        if (rendererSurfaceSnapshot.surfaces.length === 0) {
            const empty = documentValue.createElement('div')
            empty.className = 'empty'
            appendTextElement(documentValue, empty, 'strong', '', overlayText(locale, 'noRendererSurface'))
            appendTextElement(documentValue, empty, 'span', '', overlayText(locale, 'noRendererSurfaceHelp'))
            rendererSurfaceList.appendChild(empty)
            return
        }
        for (const surface of rendererSurfaceSnapshot.surfaces) {
            const button = documentValue.createElement('button')
            button.className = 'surface-button'
            button.setAttribute('type', 'button')
            button.setAttribute('data-renderer-surface', surface.id)
            button.setAttribute('data-renderer-kind', surface.kind)
            button.setAttribute('data-evidence-status', surface.evidenceStatus)
            button.setAttribute('data-selected', String(surface.id === rendererSurfaceSnapshot.selectedId))
            button.setAttribute('aria-pressed', String(surface.id === rendererSurfaceSnapshot.selectedId))
            appendTextElement(documentValue, button, 'strong', '', surface.kind === 'svg' ? 'SVG' : surface.kind.toUpperCase())
            appendTextElement(
                documentValue,
                button,
                'small',
                '',
                overlayText(
                    locale,
                    surface.evidence === 'native-svg'
                        ? 'rendererSurfaceNativeSvg'
                        : surface.evidence === 'context-registry'
                          ? 'rendererSurfaceContextObserved'
                          : 'rendererSurfaceContextUnknown'
                )
            )
            appendTextElement(
                documentValue,
                button,
                'span',
                'surface-evidence',
                overlayText(locale, surface.evidenceStatus === 'measured' ? 'rendererSurfaceMeasured' : 'rendererSurfaceUnknown')
            )
            button.addEventListener('click', () => {
                const element = rendererSurfaceInspector.elementFor(surface.id)
                if (!element) {
                    rendererSurfaceSnapshot = rendererSurfaceInspector.refresh()
                    renderRendererSurfaces()
                    return
                }
                selectElementAsTarget(element, surface.id)
            })
            rendererSurfaceList.appendChild(button)
        }
    }

    function renderTarget(pageSnapshot: AnimationSnapshot | undefined): void {
        const renderedSelection = targetSelection
        const detailScrollTop = targetDetail.scrollTop
        const detailScrollLeft = targetDetail.scrollLeft
        targetList.replaceChildren()
        targetDetail.replaceChildren()
        if (!targetSelection) {
            targetStateLabel.textContent = overlayText(locale, 'ready')
            const empty = documentValue.createElement('div')
            empty.className = 'empty'
            appendTextElement(documentValue, empty, 'strong', '', overlayText(locale, 'noSelectedTarget'))
            appendTextElement(documentValue, empty, 'span', '', overlayText(locale, 'noSelectedTargetHelp'))
            targetList.appendChild(empty)
            const privacy = documentValue.createElement('section')
            privacy.className = 'detail-section verification'
            appendTextElement(documentValue, privacy, 'h4', '', overlayText(locale, 'targetPrivacy'))
            appendTextElement(documentValue, privacy, 'p', '', overlayText(locale, 'targetPrivacyHelp'))
            targetDetail.appendChild(privacy)
            return
        }

        try {
            targetSnapshot = targetSelection.snapshot()
        } catch {
            const selection = targetSelection
            cancelTargetInteraction()
            try {
                selection.clear()
            } catch {
                // A failed local selection must not interfere with the page collector.
            }
            targetSelection = null
            targetSnapshot = null
            renderTarget(pageSnapshot)
            return
        }
        const selected = targetSnapshot
        const isRecording = selected.state === 'recording'
        const hasCorrelatedSnapshot = selected.correlated !== null
        const canRecord = selected.state !== 'disconnected'
        targetStateLabel.textContent = overlayText(
            locale,
            selected.state === 'disconnected' ? 'unavailable' : isRecording ? 'recording' : hasCorrelatedSnapshot ? 'stopped' : 'ready'
        )
        const card = documentValue.createElement('div')
        card.className = 'target-card'
        const role = selected.localDescriptor.role ? ` · role=${selected.localDescriptor.role}` : ''
        appendTextElement(documentValue, card, 'strong', '', `<${selected.localDescriptor.tagName}>${role}`)
        appendTextElement(
            documentValue,
            card,
            'span',
            '',
            `${selected.localDescriptor.mode} · ${formatOverlayMeasurement(selected.elapsedMs, 'ms', locale)}`
        )
        if (selected.state === 'disconnected') appendTextElement(documentValue, card, 'span', '', overlayText(locale, 'targetDisconnected'))
        const recordingHelp = appendTextElement(
            documentValue,
            card,
            'span',
            'target-recording-copy',
            overlayText(
                locale,
                isRecording
                    ? 'targetRecordingActiveHelp'
                    : hasCorrelatedSnapshot
                      ? 'targetRecordingStoppedHelp'
                      : 'targetRecordingReadyHelp'
            )
        )
        const recordingHelpId = `${panelId}-target-recording-help`
        recordingHelp.setAttribute('id', recordingHelpId)
        targetList.appendChild(card)
        const targetActions = documentValue.createElement('div')
        targetActions.className = 'target-actions'
        const startButton = appendTextElement(
            documentValue,
            targetActions,
            'button',
            'text-button',
            overlayText(locale, 'startTargetRecording')
        )
        startButton.setAttribute('type', 'button')
        startButton.setAttribute('data-target-recording-action', 'start')
        startButton.setAttribute('aria-describedby', recordingHelpId)
        startButton.setAttribute('title', overlayText(locale, 'startTargetRecordingTitle'))
        ;(startButton as HTMLButtonElement).disabled = !canRecord || isRecording || hasCorrelatedSnapshot
        startButton.addEventListener('click', startTargetRecording)
        const stopButton = appendTextElement(
            documentValue,
            targetActions,
            'button',
            'text-button',
            overlayText(locale, 'stopTargetRecording')
        )
        stopButton.setAttribute('type', 'button')
        stopButton.setAttribute('data-target-recording-action', 'stop')
        stopButton.setAttribute('aria-describedby', recordingHelpId)
        stopButton.setAttribute('title', overlayText(locale, 'stopTargetRecordingTitle'))
        ;(stopButton as HTMLButtonElement).disabled = targetInteraction === null
        stopButton.addEventListener('click', stopTargetRecording)
        const resetButton = appendTextElement(
            documentValue,
            targetActions,
            'button',
            'text-button',
            overlayText(locale, 'resetTargetRecording')
        )
        resetButton.setAttribute('type', 'button')
        resetButton.setAttribute('data-target-recording-action', 'reset')
        resetButton.setAttribute('aria-describedby', recordingHelpId)
        resetButton.setAttribute('title', overlayText(locale, 'resetTargetRecordingTitle'))
        ;(resetButton as HTMLButtonElement).disabled = !canRecord || (!isRecording && !hasCorrelatedSnapshot)
        resetButton.addEventListener('click', resetTargetRecording)
        const clearButton = appendTextElement(documentValue, targetActions, 'button', 'text-button', overlayText(locale, 'clearTarget'))
        clearButton.setAttribute('type', 'button')
        clearButton.setAttribute('data-target-recording-action', 'clear')
        clearButton.addEventListener('click', clearTarget)
        targetList.appendChild(targetActions)

        appendTextElement(documentValue, targetDetail, 'div', 'detail-kicker', selected.direct.relation)
        appendTextElement(documentValue, targetDetail, 'div', 'detail-title', `<${selected.localDescriptor.tagName}>`)
        appendTextElement(documentValue, targetDetail, 'div', 'detail-meta', `${selected.selectionId} · ${selected.state}`)

        const directSection = documentValue.createElement('section')
        directSection.className = 'detail-section'
        appendTextElement(documentValue, directSection, 'h4', '', overlayText(locale, 'targetDirectEvidence'))
        const directFacts = documentValue.createElement('div')
        directFacts.className = 'interaction-facts'
        appendTargetFact(
            directFacts,
            overlayText(locale, 'standardAnimations'),
            formatOverlayMeasurement(selected.direct.totalCount, 'count', locale)
        )
        appendTargetFact(
            directFacts,
            overlayText(locale, 'runningAnimations'),
            formatOverlayMeasurement(selected.direct.runningCount, 'count', locale)
        )
        appendTargetFact(
            directFacts,
            overlayText(locale, 'canvasBackingPixels'),
            formatOverlayMeasurement(selected.geometry.backingPixelArea, 'pixels', locale)
        )
        appendTargetFact(
            directFacts,
            overlayText(locale, 'effectivePixelRatio'),
            selected.geometry.effectivePixelRatio === null
                ? overlayText(locale, 'unknown')
                : `${formatOverlayMeasurement(selected.geometry.effectivePixelRatio, 'count', locale)}×`
        )
        directSection.appendChild(directFacts)
        if ((selected.direct.droppedAnimationCount ?? 0) > 0) {
            appendTextElement(
                documentValue,
                directSection,
                'p',
                '',
                overlayText(locale, 'targetInspectionTruncated', {
                    inspected: selected.direct.inspectedCount ?? 0,
                    total: selected.direct.totalCount ?? 0,
                })
            )
        }
        appendTextElement(documentValue, directSection, 'h4', '', overlayText(locale, 'animationProperties'))
        const propertyList = documentValue.createElement('div')
        propertyList.className = 'target-properties'
        const properties = [
            ...selected.direct.properties.compositorCandidate.map(property => `compositor? ${property}`),
            ...selected.direct.properties.layoutCandidate.map(property => `layout? ${property}`),
            ...selected.direct.properties.paintCandidate.map(property => `paint? ${property}`),
            ...selected.direct.properties.unknown.map(property => `unknown ${property}`),
        ]
        if (properties.length === 0) appendTextElement(documentValue, directSection, 'p', '', overlayText(locale, 'noPropertyEvidence'))
        else for (const property of properties) appendTextElement(documentValue, propertyList, 'span', '', property)
        directSection.appendChild(propertyList)
        if (selected.direct.propertyTruncated) {
            appendTextElement(documentValue, directSection, 'p', '', overlayText(locale, 'targetPropertiesTruncated'))
        }
        targetDetail.appendChild(directSection)

        const overlap = targetWindow(pageSnapshot, selected)
        const windowSection = documentValue.createElement('section')
        windowSection.className = 'detail-section'
        appendTextElement(documentValue, windowSection, 'h4', '', overlayText(locale, 'targetPageWindow'))
        const windowFacts = documentValue.createElement('div')
        windowFacts.className = 'interaction-facts'
        appendTargetFact(
            windowFacts,
            overlayText(locale, 'frameP95'),
            formatOverlayMeasurement(overlap?.frames.duration?.p95, 'ms', locale)
        )
        appendTargetFact(
            windowFacts,
            overlayText(locale, 'slowFrames'),
            formatOverlayMeasurement(overlap?.frames.slowFrameCount, 'count', locale)
        )
        appendTargetFact(windowFacts, 'LoAF', formatOverlayMeasurement(overlap?.longAnimationFrames.overlapCount, 'count', locale))
        appendTargetFact(windowFacts, 'Long Task', formatOverlayMeasurement(overlap?.longTasks.overlapCount, 'count', locale))
        windowSection.appendChild(windowFacts)
        appendTextElement(documentValue, windowSection, 'div', 'target-boundary', overlayText(locale, 'targetOverlapBoundary'))
        targetDetail.appendChild(windowSection)

        const attributionSection = documentValue.createElement('section')
        attributionSection.className = 'detail-section'
        appendTextElement(documentValue, attributionSection, 'h4', '', overlayText(locale, 'targetAttribution'))
        appendTextElement(
            documentValue,
            attributionSection,
            'p',
            '',
            `${overlayText(locale, 'runtimeInventory')}: UI ${selected.inventory.uiFrameworks.join(', ') || '—'} · meta ${
                selected.inventory.metaRuntimes.join(', ') || '—'
            } · renderer ${selected.inventory.renderers.join(', ') || '—'} · motion ${selected.inventory.motionEngines.join(', ') || '—'}`
        )
        if (selected.owners.length > 0) {
            appendList(
                documentValue,
                attributionSection,
                selected.owners.map(owner => `${owner.relation}: ${owner.label ?? owner.framework ?? owner.adapterId}`)
            )
        } else appendTextElement(documentValue, attributionSection, 'p', '', overlayText(locale, 'noOwnerAttribution'))
        if (selected.adapterErrors.length > 0) {
            appendTextElement(
                documentValue,
                attributionSection,
                'p',
                '',
                overlayText(locale, 'adapterInspectionFailed', { count: selected.adapterErrors.length })
            )
        }
        targetDetail.appendChild(attributionSection)

        const frameworkScopeSection = documentValue.createElement('section')
        frameworkScopeSection.className = 'detail-section'
        appendTextElement(
            documentValue,
            frameworkScopeSection,
            'h4',
            '',
            locale === 'zh-CN' ? '组件作用域证据（仅本地）' : 'Component scope evidence (local only)'
        )
        const frameworkScopes = selected.frameworkScopes ?? []
        if (frameworkScopes.length === 0) {
            appendTextElement(
                documentValue,
                frameworkScopeSection,
                'p',
                '',
                locale === 'zh-CN'
                    ? '当前元素没有匹配到显式组件作用域；页面级和原生 DOM 证据仍然可用。'
                    : 'No explicit component scope matched this element; page-level and native DOM evidence remain available.'
            )
        } else {
            for (const scope of frameworkScopes) {
                appendTextElement(
                    documentValue,
                    frameworkScopeSection,
                    'p',
                    '',
                    `${scope.framework} · ${scope.label ?? scope.scopeId} · ${scope.retainedRecordCount}/${scope.acceptedRecordCount}`
                )
                appendList(
                    documentValue,
                    frameworkScopeSection,
                    scope.records.map(record => {
                        const base = record.baseRenderMs === undefined ? '' : ` · base-render ${record.baseRenderMs} ms`
                        const causes =
                            record.updateCauses === undefined || record.observedCauseCount === undefined
                                ? ''
                                : ` · ${overlayText(locale, 'frameworkUpdateCauses', {
                                      causes: record.updateCauses.join(' + '),
                                      count: record.observedCauseCount,
                                  })}`
                        return `${record.kind} · ${record.reason} · ${record.reasonSource} · ${record.durationMs} ms${base}${causes}`
                    })
                )
            }
        }
        appendTextElement(
            documentValue,
            frameworkScopeSection,
            'div',
            'target-boundary',
            locale === 'zh-CN'
                ? 'render、update、check、host-script 与 commit-attested 是不同证据；commit-attested 只接受宿主独立测量。'
                : 'render, update, check, host-script, and commit-attested are distinct evidence; commit-attested requires an independent host measurement.'
        )
        targetDetail.appendChild(frameworkScopeSection)

        const videoPresentationSection = documentValue.createElement('section')
        videoPresentationSection.className = 'detail-section'
        appendTextElement(
            documentValue,
            videoPresentationSection,
            'h4',
            '',
            locale === 'zh-CN' ? '视频呈现回调证据（仅本地）' : 'Video presentation callback evidence (local only)'
        )
        const videoPresentations = selected.videoPresentations ?? []
        if (videoPresentations.length === 0) {
            appendTextElement(
                documentValue,
                videoPresentationSection,
                'p',
                '',
                locale === 'zh-CN'
                    ? '当前目标没有绑定且落在检查窗口内的 requestVideoFrameCallback 证据。'
                    : 'No bound requestVideoFrameCallback evidence fell inside this target inspection window.'
            )
        } else {
            for (const presentation of videoPresentations) {
                const latest = presentation.records.at(-1)
                const facts = documentValue.createElement('div')
                facts.className = 'interaction-facts'
                appendTargetFact(
                    facts,
                    locale === 'zh-CN' ? '启动至首次回调' : 'Start to first callback',
                    localEvidenceValue(presentation.startToFirstCallbackMs, 'ms')
                )
                appendTargetFact(
                    facts,
                    locale === 'zh-CN' ? '窗口内回调' : 'Callbacks in window',
                    formatOverlayMeasurement(presentation.retainedRecordCount, 'count', locale)
                )
                appendTargetFact(
                    facts,
                    locale === 'zh-CN' ? '最近解码处理' : 'Latest decode processing',
                    localEvidenceValue(latest?.processingDurationMs ?? null, 'ms')
                )
                appendTargetFact(
                    facts,
                    locale === 'zh-CN' ? '最近预期显示差' : 'Latest expected-display delta',
                    localEvidenceValue(latest?.expectedDisplayDeltaMs ?? null, 'ms')
                )
                videoPresentationSection.appendChild(facts)
            }
        }
        appendTextElement(
            documentValue,
            videoPresentationSection,
            'div',
            'target-boundary',
            locale === 'zh-CN'
                ? '该证据只关联显式 video 元素与 SDK 检查窗口，证明浏览器回调及其元数据；不证明 GPU 上传完成、物理 scanout 或屏幕真实首像素，并与 schema 2 调用方声明阶段严格分离。'
                : 'This evidence binds only an explicit video element to the SDK inspection window and proves browser callback metadata; it does not prove GPU upload completion, physical scanout, or a real screen first pixel, and remains separate from caller-attested schema 2 stages.'
        )
        targetDetail.appendChild(videoPresentationSection)

        const rendererSection = documentValue.createElement('section')
        rendererSection.className = 'detail-section'
        appendTextElement(documentValue, rendererSection, 'h4', '', overlayText(locale, 'targetRenderer'))
        if (selected.renderers.length === 0) {
            appendTextElement(documentValue, rendererSection, 'p', '', overlayText(locale, 'targetNoRendererAdapter'))
        } else {
            for (const renderer of selected.renderers) {
                const measured = Object.entries(renderer.metrics)
                    .filter((entry): entry is [string, number] => entry[1] !== null)
                    .map(([name, value]) => `${renderer.family}.${name}: ${value}`)
                appendTextElement(
                    documentValue,
                    rendererSection,
                    'p',
                    '',
                    `${renderer.adapterId}@${renderer.adapterVersion} · ${renderer.capability.state}${
                        renderer.capability.reason ? ` · ${renderer.capability.reason}` : ''
                    }`
                )
                const evidenceFacts = documentValue.createElement('div')
                evidenceFacts.className = 'interaction-facts'
                const count = (value: number | null): string =>
                    value === null ? overlayText(locale, 'unavailable') : formatOverlayMeasurement(value, 'count', locale)
                appendTargetFact(
                    evidenceFacts,
                    overlayText(locale, 'rendererEvidenceWindow'),
                    renderer.evidence.window.durationMs === null
                        ? overlayText(locale, 'unavailable')
                        : formatOverlayMeasurement(renderer.evidence.window.durationMs, 'ms', locale)
                )
                appendTargetFact(
                    evidenceFacts,
                    overlayText(locale, 'rendererSampleEvidence'),
                    [
                        renderer.evidence.acceptedSampleCount,
                        renderer.evidence.retainedSampleCount,
                        renderer.evidence.droppedSampleCount,
                        renderer.evidence.rejectedSampleCount,
                    ]
                        .map(count)
                        .join(' / ')
                )
                appendTargetFact(
                    evidenceFacts,
                    overlayText(locale, 'rendererTailState'),
                    renderer.evidence.truncated === null
                        ? overlayText(locale, 'unavailable')
                        : overlayText(locale, renderer.evidence.truncated ? 'rendererTailTruncated' : 'rendererTailComplete')
                )
                appendTargetFact(
                    evidenceFacts,
                    overlayText(locale, 'rendererGpuEvidence'),
                    renderer.evidence.gpu.rejectionReason === null
                        ? overlayText(locale, 'rendererGpuAccepted')
                        : overlayText(locale, 'rendererGpuRejected', { reason: renderer.evidence.gpu.rejectionReason })
                )
                rendererSection.appendChild(evidenceFacts)
                if (measured.length > 0) appendList(documentValue, rendererSection, measured)
            }
        }
        targetDetail.appendChild(rendererSection)

        const privacy = documentValue.createElement('section')
        privacy.className = 'detail-section verification'
        appendTextElement(documentValue, privacy, 'h4', '', overlayText(locale, 'targetPrivacy'))
        appendTextElement(documentValue, privacy, 'p', '', overlayText(locale, 'targetPrivacyHelp'))
        targetDetail.appendChild(privacy)
        if (renderedSelection !== null && targetSelection === renderedSelection) {
            targetDetail.scrollTop = detailScrollTop
            targetDetail.scrollLeft = detailScrollLeft
        }
    }

    const renderViewModel = (snapshot: AnimationSnapshot, viewModel: AnimationOverlayViewModel, recordHistory = true): void => {
        unavailableRendered = false
        lastSnapshot = snapshot
        currentViewModel = viewModel
        syncCollectorState(snapshot.state)
        diagnosis.setAttribute('data-state', viewModel.captureState)
        diagnosisHeadline.textContent = viewModel.headline
        diagnosisSummary.textContent = viewModel.summary
        captureMeta.textContent = viewModel.captureMeta
        metricGrid.replaceChildren()
        for (const metric of viewModel.metrics) {
            const card = documentValue.createElement('div')
            card.className = 'metric'
            card.setAttribute('data-metric', metric.id)
            card.setAttribute('data-tone', metric.tone)
            if (metric.id === 'live-fps') card.setAttribute('title', overlayText(locale, 'recentFpsBoundary'))
            if (metric.id === 'input-scheduling') card.setAttribute('title', overlayText(locale, 'inputFrameSchedulingBoundary'))
            if (metric.id === 'loaf-render-paint' || metric.id === 'loaf-paint-presentation') {
                card.setAttribute('title', overlayText(locale, 'loafPaintTimingBoundary'))
            }
            appendTextElement(documentValue, card, 'div', 'metric-label', metric.label)
            appendTextElement(documentValue, card, 'div', 'metric-value', metric.value)
            appendTextElement(documentValue, card, 'div', 'metric-context', metric.context)
            metricGrid.appendChild(card)
        }
        renderOverviewEvidence(viewModel)
        renderPageEvidence(currentPageEvidence)
        renderLocalEvidence(currentLocalEvidence)
        if (recordHistory) issueHistory = updateOverlayIssueHistory(issueHistory, viewModel.issues, snapshot.capturedAt)
        const activeIssueCount = issueHistory.filter(issue => issue.active).length
        triggerBadge.textContent = activeIssueCount > 99 ? '99+' : String(activeIssueCount)
        triggerBadge.setAttribute(
            'aria-label',
            overlayText(locale, activeIssueCount === 1 ? 'findingsOne' : 'findingsMany', { count: activeIssueCount })
        )
        triggerBadge.setAttribute('data-visible', String(activeIssueCount > 0))
        renderIssueHistory()
        renderInteractions(viewModel.interactions)
        renderCoverage(viewModel)
        renderRendererSurfaces()
        renderTarget(snapshot)
    }

    const renderUnavailable = (): void => {
        unavailableRendered = true
        lastSnapshot = undefined
        currentViewModel = undefined
        syncCollectorState()
        diagnosis.setAttribute('data-state', 'collecting')
        diagnosisHeadline.textContent = overlayText(locale, 'collectorUnavailable')
        diagnosisSummary.textContent = overlayText(locale, 'collectorUnavailableHelp')
        captureMeta.textContent = collectorStateText(locale, readCollectorState(source))
        metricGrid.replaceChildren()
        for (const label of [
            overlayText(locale, 'recentFps'),
            overlayText(locale, 'frameTail'),
            overlayText(locale, 'jankBursts'),
            overlayText(locale, 'missedDisplays'),
        ]) {
            const card = documentValue.createElement('div')
            card.className = 'metric'
            card.setAttribute('data-tone', 'unknown')
            appendTextElement(documentValue, card, 'div', 'metric-label', label)
            appendTextElement(documentValue, card, 'div', 'metric-value', overlayText(locale, 'unknown'))
            appendTextElement(documentValue, card, 'div', 'metric-context', overlayText(locale, 'noLocalSnapshot'))
            metricGrid.appendChild(card)
        }
        renderOverviewEvidence()
        renderPageEvidence({ status: 'absent' })
        renderLocalEvidence({ status: 'absent' })
        renderIssueHistory()
        renderInteractions([])
        coverageGrid.replaceChildren()
        coverageCount.textContent = overlayText(locale, 'coverageCount', { count: 0 })
        coverageDetail.replaceChildren()
        renderRendererSurfaces()
        renderTarget(undefined)
    }

    const refresh = (): void => {
        if (destroyed || !expanded) return
        const startedAt = safeNow(timerOwner)
        try {
            const snapshot = source.snapshot()
            currentPageEvidence = readPageEvidenceSnapshot(source)
            currentLocalEvidence = readLocalEvidenceSnapshot(source)
            lastLiveFrameRate = measureLiveFrameRate(previousFrameRateSnapshot, snapshot)
            previousFrameRateSnapshot = snapshot
            renderViewModel(snapshot, buildAnimationOverlayViewModel(snapshot, locale, lastLiveFrameRate))
        } catch {
            currentPageEvidence = { status: 'absent' }
            currentLocalEvidence = { status: 'absent' }
            previousFrameRateSnapshot = undefined
            lastLiveFrameRate = { status: 'not-observed' }
            renderUnavailable()
        }
        const endedAt = safeNow(timerOwner)
        lastPanelSelfTime =
            startedAt === null || endedAt === null
                ? overlayText(locale, 'unavailable')
                : formatOverlayMeasurement(endedAt - startedAt, 'ms', locale)
        footerTiming.textContent = overlayText(locale, 'panelRefresh', {
            selfTime: lastPanelSelfTime,
            seconds: refreshIntervalMs / 1_000,
        })
    }

    const stopRefreshLoop = (): void => {
        if (timerId === undefined) return
        timerOwner?.clearInterval(timerId)
        timerId = undefined
    }
    const startRefreshLoop = (): void => {
        if (timerId !== undefined) return
        timerId = timerOwner?.setInterval(refresh, refreshIntervalMs)
    }
    const syncExpandedState = (): void => {
        dock.setAttribute('data-expanded', String(expanded))
        panel.setAttribute('aria-hidden', String(!expanded))
        panel.inert = !expanded
        trigger.setAttribute('aria-expanded', String(expanded))
        trigger.setAttribute('aria-label', overlayText(locale, expanded ? 'closeMonitor' : 'openMonitor'))
        trigger.setAttribute('title', overlayText(locale, expanded ? 'closeMonitorTitle' : 'openMonitorTitle'))
        syncCollectorState()
    }

    const applyLocaleCopy = (): void => {
        host.setAttribute('lang', locale)
        panel.setAttribute('aria-label', overlayText(locale, 'panelAria'))
        metricGrid.setAttribute('aria-label', overlayText(locale, 'primaryMeasurementsAria'))
        tabs.setAttribute('aria-label', overlayText(locale, 'viewsAria'))
        triggerLabel.textContent = overlayText(locale, 'motion')
        productTitle.textContent = overlayText(locale, 'motionConsole')
        issueHeadingLabel.textContent = overlayText(locale, 'issueHistory')
        interactionHeadingLabel.textContent = overlayText(locale, 'recentInteractions')
        coverageHeadingLabel.textContent = overlayText(locale, 'metricCoverage')
        rendererSurfaceHeadingLabel.textContent = overlayText(locale, 'rendererSurfaces')
        targetHeadingLabel.textContent = overlayText(locale, 'selectedTarget')
        footerLocalLabel.textContent = overlayText(locale, 'localView')
        closeButton.setAttribute('aria-label', overlayText(locale, 'closeMonitor'))
        closeButton.setAttribute('title', overlayText(locale, 'close'))
        product.setAttribute('aria-label', overlayText(locale, 'movePanel'))
        launcherMoveHelp.textContent = overlayText(locale, 'launcherMoveHelp')
        panelMoveHelp.textContent = overlayText(locale, 'panelMoveHelp')
        pickerButton.setAttribute('aria-label', overlayText(locale, 'selectTarget'))
        pickerButton.setAttribute(
            'title',
            overlayText(locale, typeof source.selectElement === 'function' ? 'selectTargetTitle' : 'targetPickerUnavailable')
        )
        localeButton.textContent = locale === 'en' ? '中' : 'EN'
        localeButton.setAttribute('lang', locale === 'en' ? 'zh-CN' : 'en')
        localeButton.setAttribute('aria-label', overlayText(locale, locale === 'en' ? 'switchToChinese' : 'switchToEnglish'))
        localeButton.setAttribute('title', overlayText(locale, locale === 'en' ? 'switchToChinese' : 'switchToEnglish'))
        for (const tab of OVERLAY_TABS) {
            const button = tabButtons.get(tab)
            if (button) button.textContent = overlayTabText(locale, tab)
        }
        syncCollectorState()
        syncLayout()
        syncExpandedState()
        if (lastSnapshot) {
            issueHistory = localizeOverlayIssueHistory(issueHistory, locale)
            renderViewModel(lastSnapshot, buildAnimationOverlayViewModel(lastSnapshot, locale, lastLiveFrameRate), false)
        } else if (unavailableRendered) {
            renderUnavailable()
        } else {
            diagnosisHeadline.textContent = overlayText(locale, 'waitingSnapshot')
            diagnosisSummary.textContent = overlayText(locale, 'openForEvidence')
            captureMeta.textContent = collectorStateText(locale, readCollectorState(source))
            issueCount.textContent = overlayText(locale, 'currentRetained', { current: 0, retained: issueHistory.length })
            interactionCount.textContent = overlayText(locale, 'retained', { count: 0 })
            coverageCount.textContent = overlayText(locale, 'coverageCount', { count: 0 })
            renderOverviewEvidence()
            renderPageEvidence({ status: 'absent' })
            renderLocalEvidence({ status: 'absent' })
            renderIssueHistory()
            renderInteractions([])
            coverageDetail.replaceChildren()
            renderRendererSurfaces()
            renderTarget(undefined)
        }
        if (!lastSnapshot) lastPanelSelfTime = overlayText(locale, 'unavailable')
        footerTiming.textContent = lastSnapshot
            ? overlayText(locale, 'panelRefresh', {
                  selfTime: lastPanelSelfTime,
                  seconds: refreshIntervalMs / 1_000,
              })
            : overlayText(locale, 'refreshAtLeast', { seconds: refreshIntervalMs / 1_000 })
    }
    const setExpanded = (nextExpanded: boolean): void => {
        if (destroyed || expanded === nextExpanded) return
        const activeElement = shadow.activeElement
        const returnFocusToTrigger = !nextExpanded && activeElement !== null && (activeElement === panel || panel.contains(activeElement))
        expanded = nextExpanded
        syncExpandedState()
        if (expanded) {
            applySurfacePosition('panel')
            previousFrameRateSnapshot = undefined
            lastLiveFrameRate = { status: 'collecting' }
            refresh()
            startRefreshLoop()
        } else {
            applySurfacePosition('launcher')
            stopRefreshLoop()
            previousFrameRateSnapshot = undefined
            lastLiveFrameRate = { status: 'collecting' }
            if (returnFocusToTrigger) trigger.focus()
        }
    }
    const toggle = (): void => setExpanded(!expanded)
    const onTriggerClick = (event: MouseEvent): void => {
        if (suppressNextPointerClick && event.detail > 0) {
            suppressNextPointerClick = false
            event.preventDefault()
            event.stopImmediatePropagation()
            return
        }
        suppressNextPointerClick = false
        toggle()
    }
    const onCloseClick = (): void => setExpanded(false)
    const onLayoutClick = (): void => {
        layout = layout === 'compact' ? 'wide' : 'compact'
        syncLayout()
        persistViewPreference()
    }
    const onLocaleClick = (): void => {
        locale = locale === 'en' ? 'zh-CN' : 'en'
        applyLocaleCopy()
        persistViewPreference()
    }
    const onRendererSurfaceToggle = (): void => {
        rendererSurfaceInspector.setEnabled(!rendererSurfaceInspector.enabled)
        rendererSurfaceSnapshot = rendererSurfaceInspector.snapshot()
        renderRendererSurfaces()
    }
    const onRendererSurfaceRefresh = (): void => {
        rendererSurfaceSnapshot = rendererSurfaceInspector.refresh()
        renderRendererSurfaces()
    }
    const picker = createAnimationElementPicker({
        document: documentValue,
        exclude: element => element === host || host.contains(element),
        onStateChange(state) {
            pickerButton.setAttribute('data-picker-state', state)
            pickerButton.setAttribute('aria-pressed', String(state === 'picking'))
            if (state === 'picking') productState.textContent = overlayText(locale, 'pickingTarget')
        },
        onCancel() {
            if (restorePanelAfterPick) setExpanded(true)
            restorePanelAfterPick = false
            syncCollectorState()
        },
        onSelect(element) {
            restorePanelAfterPick = false
            selectElementAsTarget(element)
            refresh()
        },
    })
    const startTargetPicker = (): boolean => {
        if (destroyed || typeof source.selectElement !== 'function') return false
        restorePanelAfterPick = expanded
        const started = picker.start()
        if (started) setExpanded(false)
        else restorePanelAfterPick = false
        return started
    }
    const onPickerClick = (): void => {
        if (picker.state === 'picking') picker.cancel()
        else startTargetPicker()
    }
    const tabClickHandlers = new Map<OverlayTab, () => void>()
    const tabKeyHandlers = new Map<OverlayTab, (event: KeyboardEvent) => void>()
    for (const [index, tab] of OVERLAY_TABS.entries()) {
        const clickHandler = (): void => setActiveTab(tab)
        const keyHandler = (event: KeyboardEvent): void => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const nextIndex =
                event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? OVERLAY_TABS.length - 1
                      : (index + (event.key === 'ArrowRight' ? 1 : -1) + OVERLAY_TABS.length) % OVERLAY_TABS.length
            setActiveTab(OVERLAY_TABS[nextIndex] ?? 'overview', true)
        }
        tabButtons.get(tab)?.addEventListener('click', clickHandler)
        tabButtons.get(tab)?.addEventListener('keydown', keyHandler)
        tabClickHandlers.set(tab, clickHandler)
        tabKeyHandlers.set(tab, keyHandler)
    }
    const onContainedInput = (event: Event): void => event.stopPropagation()
    const containedInputTypes = [
        'click',
        'dblclick',
        'auxclick',
        'pointerdown',
        'pointerup',
        'pointercancel',
        'pointermove',
        'pointerover',
        'pointerout',
        'mousedown',
        'mouseup',
        'mousemove',
        'mouseover',
        'mouseout',
        'touchstart',
        'touchmove',
        'touchend',
        'touchcancel',
        'wheel',
        'contextmenu',
        'focusin',
        'focusout',
    ] as const
    const onShadowKeyDown = (event: Event): void => {
        event.stopPropagation()
        if (expanded && (event as KeyboardEvent).key === 'Escape') {
            event.preventDefault()
            setExpanded(false)
            trigger.focus()
        }
    }
    const onLauncherPointerDown = (event: PointerEvent): void => beginSurfaceDrag('launcher', trigger, event)
    const onLauncherPointerMove = (event: PointerEvent): void => updateActiveDrag(event)
    const onLauncherPointerUp = (event: PointerEvent): void => finishActiveDrag(event, true)
    const onLauncherPointerCancel = (event: PointerEvent): void => finishActiveDrag(event, false)
    const onPanelPointerDown = (event: PointerEvent): void => beginSurfaceDrag('panel', product, event)
    const onPanelPointerMove = (event: PointerEvent): void => updateActiveDrag(event)
    const onPanelPointerUp = (event: PointerEvent): void => finishActiveDrag(event, true)
    const onPanelPointerCancel = (event: PointerEvent): void => finishActiveDrag(event, false)
    const onLauncherKeyDown = (event: KeyboardEvent): void => onSurfaceKeyDown('launcher', event)
    const onPanelKeyDown = (event: KeyboardEvent): void => onSurfaceKeyDown('panel', event)
    trigger.addEventListener('click', onTriggerClick)
    trigger.addEventListener('pointerdown', onLauncherPointerDown)
    trigger.addEventListener('pointermove', onLauncherPointerMove)
    trigger.addEventListener('pointerup', onLauncherPointerUp)
    trigger.addEventListener('pointercancel', onLauncherPointerCancel)
    trigger.addEventListener('lostpointercapture', onLauncherPointerCancel)
    trigger.addEventListener('keydown', onLauncherKeyDown)
    product.addEventListener('pointerdown', onPanelPointerDown)
    product.addEventListener('pointermove', onPanelPointerMove)
    product.addEventListener('pointerup', onPanelPointerUp)
    product.addEventListener('pointercancel', onPanelPointerCancel)
    product.addEventListener('lostpointercapture', onPanelPointerCancel)
    product.addEventListener('keydown', onPanelKeyDown)
    pickerButton.addEventListener('click', onPickerClick)
    closeButton.addEventListener('click', onCloseClick)
    localeButton.addEventListener('click', onLocaleClick)
    layoutButton.addEventListener('click', onLayoutClick)
    rendererSurfaceToggle.addEventListener('click', onRendererSurfaceToggle)
    rendererSurfaceRefresh.addEventListener('click', onRendererSurfaceRefresh)
    for (const type of containedInputTypes) shadow.addEventListener(type, onContainedInput, { passive: true })
    shadow.addEventListener('keydown', onShadowKeyDown)
    shadow.addEventListener('keyup', onContainedInput)
    timerOwner?.addEventListener('resize', onViewportChange)
    timerOwner?.visualViewport?.addEventListener('resize', onViewportChange)
    timerOwner?.visualViewport?.addEventListener('scroll', onViewportChange)
    onViewportChange()
    setActiveTab(activeTab)
    applyLocaleCopy()
    if (expanded) {
        refresh()
        startRefreshLoop()
    }

    return {
        mounted: true,
        refreshIntervalMs,
        get expanded() {
            return expanded
        },
        get targetState() {
            return targetSelection?.state ?? (picker.state === 'selected' ? 'idle' : picker.state)
        },
        setExpanded,
        toggle,
        startTargetPicker,
        clearTarget,
        refresh,
        destroy(): void {
            if (destroyed) return
            destroyed = true
            stopRefreshLoop()
            picker.destroy()
            rendererSurfaceInspector.destroy()
            const selection = targetSelection
            cancelTargetInteraction()
            try {
                selection?.clear()
            } catch {
                // Destroying the overlay never changes the page collector lifecycle.
            }
            targetSelection = null
            trigger.removeEventListener('click', onTriggerClick)
            trigger.removeEventListener('pointerdown', onLauncherPointerDown)
            trigger.removeEventListener('pointermove', onLauncherPointerMove)
            trigger.removeEventListener('pointerup', onLauncherPointerUp)
            trigger.removeEventListener('pointercancel', onLauncherPointerCancel)
            trigger.removeEventListener('lostpointercapture', onLauncherPointerCancel)
            trigger.removeEventListener('keydown', onLauncherKeyDown)
            product.removeEventListener('pointerdown', onPanelPointerDown)
            product.removeEventListener('pointermove', onPanelPointerMove)
            product.removeEventListener('pointerup', onPanelPointerUp)
            product.removeEventListener('pointercancel', onPanelPointerCancel)
            product.removeEventListener('lostpointercapture', onPanelPointerCancel)
            product.removeEventListener('keydown', onPanelKeyDown)
            pickerButton.removeEventListener('click', onPickerClick)
            closeButton.removeEventListener('click', onCloseClick)
            localeButton.removeEventListener('click', onLocaleClick)
            layoutButton.removeEventListener('click', onLayoutClick)
            rendererSurfaceToggle.removeEventListener('click', onRendererSurfaceToggle)
            rendererSurfaceRefresh.removeEventListener('click', onRendererSurfaceRefresh)
            for (const tab of OVERLAY_TABS) {
                const button = tabButtons.get(tab)
                const clickHandler = tabClickHandlers.get(tab)
                const keyHandler = tabKeyHandlers.get(tab)
                if (clickHandler) button?.removeEventListener('click', clickHandler)
                if (keyHandler) button?.removeEventListener('keydown', keyHandler)
            }
            for (const type of containedInputTypes) shadow.removeEventListener(type, onContainedInput)
            shadow.removeEventListener('keydown', onShadowKeyDown)
            shadow.removeEventListener('keyup', onContainedInput)
            timerOwner?.removeEventListener('resize', onViewportChange)
            timerOwner?.visualViewport?.removeEventListener('resize', onViewportChange)
            timerOwner?.visualViewport?.removeEventListener('scroll', onViewportChange)
            const drag = activeDrag
            activeDrag = undefined
            if (drag) {
                try {
                    if (drag.handle.hasPointerCapture?.(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId)
                } catch {
                    // Destruction must stay idempotent if capture already ended.
                }
            }
            host.remove()
        },
    }
}
