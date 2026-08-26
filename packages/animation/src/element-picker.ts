import type { AnimationElementPicker, AnimationElementPickerOptions, AnimationElementPickerState } from './types'

// cspell:ignore Menlo

function elementLike(value: unknown): value is Element {
    return Boolean(
        value &&
            typeof value === 'object' &&
            typeof (value as Element).getBoundingClientRect === 'function' &&
            typeof (value as Element).tagName === 'string'
    )
}

function pointElement(documentValue: Document, event: PointerEvent | MouseEvent): Element | null {
    try {
        const path = event.composedPath?.() ?? []
        const pathElement = path.find(elementLike)
        if (pathElement) return pathElement
    } catch {
        // Fall through to the document hit test.
    }
    try {
        return documentValue.elementFromPoint(event.clientX, event.clientY)
    } catch {
        return null
    }
}

/**
 * One-shot, development-oriented DOM picker. It installs capture listeners only
 * while picking and never starts, pauses, filters, or uploads page collection.
 */
export function createAnimationElementPicker(options: AnimationElementPickerOptions): AnimationElementPicker {
    const documentValue = options.document ?? (typeof document === 'undefined' ? undefined : document)
    const mountTarget = documentValue?.body ?? documentValue?.documentElement
    let state: AnimationElementPickerState = 'idle'
    let candidate: Element | null = null
    let host: HTMLElement | null = null
    let glass: HTMLElement | null = null
    let outline: HTMLElement | null = null
    let label: HTMLElement | null = null
    let frameId: number | null = null
    let pendingEvent: PointerEvent | MouseEvent | null = null

    const setState = (next: AnimationElementPickerState): void => {
        state = next
        options.onStateChange?.(next)
    }

    const excluded = (element: Element | null): boolean => {
        if (!element) return true
        if (host && (element === host || host.contains(element))) return true
        try {
            if (element.closest('[data-condev-animation-overlay],[data-condev-animation-picker]')) return true
        } catch {
            return true
        }
        return options.exclude?.(element) ?? false
    }

    const renderCandidate = (next: Element | null): void => {
        candidate = excluded(next) ? null : next
        if (!outline || !label) return
        if (!candidate) {
            outline.style.display = 'none'
            label.style.display = 'none'
            return
        }
        try {
            const rect = candidate.getBoundingClientRect()
            outline.style.display = 'block'
            outline.style.transform = `translate(${Math.round(rect.left)}px, ${Math.round(rect.top)}px)`
            outline.style.width = `${Math.max(0, Math.round(rect.width))}px`
            outline.style.height = `${Math.max(0, Math.round(rect.height))}px`
            label.style.display = 'block'
            label.style.transform = `translate(${Math.max(4, Math.round(rect.left))}px, ${Math.max(4, Math.round(rect.top) - 26)}px)`
            label.textContent = candidate.tagName.toLowerCase()
        } catch {
            candidate = null
            outline.style.display = 'none'
            label.style.display = 'none'
        }
    }

    const inspectedElement = (event: PointerEvent | MouseEvent): Element | null => {
        if (!glass) return pointElement(documentValue!, event)
        const previousPointerEvents = glass.style.pointerEvents
        try {
            glass.style.pointerEvents = 'none'
            return documentValue?.elementFromPoint(event.clientX, event.clientY) ?? null
        } catch {
            return null
        } finally {
            glass.style.pointerEvents = previousPointerEvents
        }
    }

    const flushPointerMove = (): void => {
        frameId = null
        const event = pendingEvent
        pendingEvent = null
        if (!event || state !== 'picking') return
        renderCandidate(inspectedElement(event))
    }

    const onPointerMove = (event: PointerEvent): void => {
        pendingEvent = event
        if (frameId !== null) return
        const requestFrame = documentValue?.defaultView?.requestAnimationFrame
        if (requestFrame) frameId = requestFrame.call(documentValue.defaultView, flushPointerMove)
        else flushPointerMove()
    }

    const suppressHostInput = (event: Event): void => {
        event.preventDefault()
        event.stopPropagation()
        ;(event as Event & { stopImmediatePropagation?: () => void }).stopImmediatePropagation?.()
    }

    const onPointerDown = (event: PointerEvent): void => {
        if (event.button !== 0) return
        renderCandidate(inspectedElement(event))
        suppressHostInput(event)
    }

    const finishPick = (next: Element): void => {
        removeActiveListeners()
        removeVisuals()
        setState('selected')
        options.onSelect(next)
    }

    const onClick = (event: MouseEvent): void => {
        suppressHostInput(event)
        renderCandidate(inspectedElement(event))
        if (!candidate) return
        const selected = candidate
        candidate = null
        finishPick(selected)
    }

    const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key !== 'Escape') return
        suppressHostInput(event)
        cancel()
    }

    const onViewportChange = (): void => {
        if (state === 'picking') renderCandidate(candidate)
    }

    function addActiveListeners(): void {
        documentValue?.addEventListener?.('pointermove', onPointerMove, true)
        documentValue?.addEventListener?.('pointerdown', onPointerDown, true)
        documentValue?.addEventListener?.('click', onClick, true)
        documentValue?.addEventListener?.('keydown', onKeyDown, true)
        documentValue?.addEventListener?.('scroll', onViewportChange, true)
        documentValue?.defaultView?.addEventListener?.('resize', onViewportChange, true)
    }

    function removeActiveListeners(): void {
        documentValue?.removeEventListener?.('pointermove', onPointerMove, true)
        documentValue?.removeEventListener?.('pointerdown', onPointerDown, true)
        documentValue?.removeEventListener?.('click', onClick, true)
        documentValue?.removeEventListener?.('keydown', onKeyDown, true)
        documentValue?.removeEventListener?.('scroll', onViewportChange, true)
        documentValue?.defaultView?.removeEventListener?.('resize', onViewportChange, true)
        if (frameId !== null) documentValue?.defaultView?.cancelAnimationFrame?.(frameId)
        frameId = null
        pendingEvent = null
    }

    function mountVisuals(): boolean {
        if (!documentValue || !mountTarget || typeof documentValue.createElement !== 'function') return false
        host = documentValue.createElement('div')
        host.setAttribute('data-condev-animation-picker', '')
        const shadow = host.attachShadow({ mode: 'open' })
        const style = documentValue.createElement('style')
        style.textContent = `
            :host { all: initial; position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; }
            .glass { position: fixed; inset: 0; pointer-events: auto; cursor: crosshair; background: transparent; }
            .outline { display: none; position: fixed; left: 0; top: 0; border: 2px solid #9b87f5; border-radius: 4px;
                pointer-events: none; background: rgba(155,135,245,.10); box-shadow: 0 0 0 1px rgba(11,11,14,.8), 0 0 0 9999px rgba(7,7,10,.08); }
            .label { display: none; position: fixed; left: 0; top: 0; max-width: 240px; padding: 4px 7px; border-radius: 5px;
                color: #f4f4f6; background: #7058d6; font: 600 11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;
                pointer-events: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            @media (prefers-reduced-motion: reduce) { .outline, .label { transition: none; } }
        `
        glass = documentValue.createElement('div')
        glass.className = 'glass'
        glass.setAttribute('aria-hidden', 'true')
        outline = documentValue.createElement('div')
        outline.className = 'outline'
        label = documentValue.createElement('div')
        label.className = 'label'
        label.setAttribute('aria-hidden', 'true')
        shadow.append(style, glass, outline, label)
        mountTarget.appendChild(host)
        return true
    }

    function removeVisuals(): void {
        host?.remove()
        host = null
        glass = null
        outline = null
        label = null
        candidate = null
    }

    function cancel(): void {
        if (state !== 'picking') return
        removeActiveListeners()
        removeVisuals()
        setState('idle')
        options.onCancel?.()
    }

    return {
        get state() {
            return state
        },
        start() {
            if (state === 'destroyed' || !documentValue || state === 'picking') return false
            removeActiveListeners()
            removeVisuals()
            if (!mountVisuals()) return false
            setState('picking')
            addActiveListeners()
            return true
        },
        cancel,
        destroy() {
            if (state === 'destroyed') return
            const notifyCancel = state === 'picking'
            removeActiveListeners()
            removeVisuals()
            setState('destroyed')
            if (notifyCancel) options.onCancel?.()
        },
    }
}
