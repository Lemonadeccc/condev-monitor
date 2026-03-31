'use client'

import { CalendarDays, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

function splitDateTimeValue(value: string) {
    if (!value) return { date: '', time: '00:00' }
    const [date = '', time = '00:00'] = value.split('T')
    return { date, time: time.slice(0, 5) || '00:00' }
}

function combineDateTimeValue(date: string, time: string) {
    if (!date) return ''
    return `${date}T${time || '00:00'}`
}

function formatTriggerLabel(value: string, placeholder: string) {
    if (!value) return placeholder

    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return placeholder

    return new Intl.DateTimeFormat('en-US', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).format(date)
}

type DateTimeFilterProps = {
    value: string
    onChange: (value: string) => void
    placeholder: string
    className?: string
}

export function DateTimeFilter({ value, onChange, placeholder, className }: DateTimeFilterProps) {
    const [open, setOpen] = useState(false)
    const [draftDate, setDraftDate] = useState('')
    const [draftTime, setDraftTime] = useState('00:00')
    const containerRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!open) {
            const { date, time } = splitDateTimeValue(value)
            setDraftDate(date)
            setDraftTime(time)
        }
    }, [open, value])

    useEffect(() => {
        if (!open) return

        const handlePointerDown = (event: MouseEvent) => {
            if (!containerRef.current?.contains(event.target as Node)) {
                setOpen(false)
            }
        }

        document.addEventListener('mousedown', handlePointerDown)
        return () => document.removeEventListener('mousedown', handlePointerDown)
    }, [open])

    const selectedDate = useMemo(() => {
        if (!draftDate) return undefined
        const date = new Date(`${draftDate}T00:00:00`)
        return Number.isNaN(date.getTime()) ? undefined : date
    }, [draftDate])

    return (
        <div ref={containerRef} className={cn('relative', className)}>
            <Button type="button" variant="outline" size="sm" className="min-w-[220px] justify-start" onClick={() => setOpen(v => !v)}>
                <CalendarDays className="mr-2 h-4 w-4" />
                <span className="truncate">{formatTriggerLabel(value, placeholder)}</span>
            </Button>

            {open ? (
                <Card className="absolute right-0 top-10 z-50 w-[320px] gap-4 p-3 shadow-lg">
                    <Calendar
                        mode="single"
                        selected={selectedDate}
                        onSelect={date => {
                            if (!date) return
                            setDraftDate(
                                `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
                            )
                        }}
                        captionLayout="dropdown"
                        className="rounded-md border"
                    />

                    <div className="space-y-2">
                        <div className="text-xs font-medium text-muted-foreground">Time</div>
                        <Input
                            type="time"
                            value={draftTime}
                            onChange={event => setDraftTime(event.target.value || '00:00')}
                            className="h-9"
                        />
                    </div>

                    <div className="flex items-center justify-between gap-2">
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                                setDraftDate('')
                                setDraftTime('00:00')
                                onChange('')
                                setOpen(false)
                            }}
                        >
                            <X className="mr-2 h-4 w-4" />
                            Clear
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            onClick={() => {
                                onChange(combineDateTimeValue(draftDate, draftTime))
                                setOpen(false)
                            }}
                        >
                            Apply
                        </Button>
                    </div>
                </Card>
            ) : null}
        </div>
    )
}
