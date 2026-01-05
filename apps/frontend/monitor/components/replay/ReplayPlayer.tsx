'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import RRWebPlayer from 'rrweb-player'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export type ReplayEvent = {
    type: number
    timestamp: number
    data: unknown
}

function isRrwebEvent(value: unknown): value is ReplayEvent {
    if (!value || typeof value !== 'object') return false
    const obj = value as Record<string, unknown>
    return typeof obj.timestamp === 'number' && typeof obj.type === 'number'
}

function isRrwebEventArray(value: unknown): value is ReplayEvent[] {
    return Array.isArray(value) && (value.length === 0 || isRrwebEvent(value[0]))
}

export function ReplayPlayer(props: { snapshot: string; events: unknown[]; errorAtMs?: number | null; className?: string }) {
    const { events, errorAtMs, className } = props
    const containerRef = useRef<HTMLDivElement | null>(null)
    const playerRef = useRef<(InstanceType<typeof RRWebPlayer> & { $destroy?: () => void }) | null>(null)
    const [ready, setReady] = useState(false)

    const rrwebEvents = useMemo(() => {
        if (!isRrwebEventArray(events)) return []
        const list = events.slice()
        list.sort((a, b) => a.timestamp - b.timestamp)
        return list
    }, [events])

    const startTs = rrwebEvents.length ? rrwebEvents[0]!.timestamp : null
    const errorOffset = useMemo(() => {
        if (!startTs || !errorAtMs) return null
        const offset = errorAtMs - startTs
        return Number.isFinite(offset) ? Math.max(0, offset) : null
    }, [errorAtMs, startTs])

    useEffect(() => {
        const container = containerRef.current
        if (!container) return

        setReady(false)
        container.innerHTML = ''

        if (playerRef.current) {
            playerRef.current.$destroy?.()
            playerRef.current = null
        }

        if (!rrwebEvents.length) return

        playerRef.current = new RRWebPlayer({
            target: container,
            props: {
                events: rrwebEvents,
                width: 1024,
                height: 576,
                maxScale: 1,
                autoPlay: false,
                showController: true,
                mouseTail: true,
            },
        })
        setReady(true)

        return () => {
            if (playerRef.current) {
                playerRef.current.$destroy?.()
                playerRef.current = null
            }
        }
    }, [rrwebEvents])

    if (!rrwebEvents.length) {
        return <div className={cn('text-sm text-muted-foreground', className)}>No rrweb events found. Please record a new replay.</div>
    }

    return (
        <div className={cn('flex flex-col gap-3', className)}>
            <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                    {errorOffset !== null ? (
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={!ready}
                            onClick={() => {
                                playerRef.current?.goto(errorOffset, true)
                            }}
                        >
                            Jump to error
                        </Button>
                    ) : null}
                </div>
                <div className="text-xs text-muted-foreground font-mono tabular-nums">{rrwebEvents.length} events</div>
            </div>
            <div ref={containerRef} className="rounded-md border bg-background" />
        </div>
    )
}
