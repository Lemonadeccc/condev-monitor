'use client'

import { useState } from 'react'

import { cn } from '@/lib/utils'

import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import { Input } from '../ui/input'

export function CreateApplicationDialog(props: {
    open: boolean
    onOpenChange: (open: boolean) => void
    onCreate: (values: { type: 'vanilla'; name: string }) => Promise<void>
}) {
    const { open, onOpenChange, onCreate } = props
    const [type, setType] = useState<'vanilla'>('vanilla')
    const [name, setName] = useState('')
    const [submitting, setSubmitting] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const reset = () => {
        setType('vanilla')
        setName('')
        setError(null)
    }

    const handleCreate = async () => {
        setError(null)
        const trimmed = name.trim()
        if (!trimmed) {
            setError('Please enter an application name.')
            return
        }
        setSubmitting(true)
        try {
            await onCreate({ type, name: trimmed })
            onOpenChange(false)
            reset()
        } catch (e) {
            setError((e as Error)?.message || 'Create failed. Please try again.')
        } finally {
            setSubmitting(false)
        }
    }

    return (
        <Dialog
            open={open}
            onOpenChange={next => {
                if (next) onOpenChange(true)
                else {
                    onOpenChange(false)
                    reset()
                }
            }}
        >
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Create monitoring app</DialogTitle>
                    <DialogDescription>Select the project type and enter an app name to create a new monitoring project.</DialogDescription>
                </DialogHeader>

                <div className="grid gap-4">
                    <div className="grid gap-2">
                        <label className="text-sm font-medium">App type</label>
                        <select
                            className={cn(
                                'border-input h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none',
                                'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
                                'dark:bg-input/30'
                            )}
                            value={type}
                            onChange={e => setType(e.target.value as 'vanilla')}
                        >
                            <option value="vanilla">JavaScript</option>
                        </select>
                    </div>

                    <div className="grid gap-2">
                        <label className="text-sm font-medium">App name</label>
                        <Input value={name} onChange={e => setName(e.target.value)} placeholder="Enter app name" />
                    </div>

                    {error ? <div className="text-sm text-destructive">{error}</div> : null}
                </div>

                <DialogFooter>
                    <Button className="w-full sm:w-auto" onClick={handleCreate} disabled={submitting}>
                        {submitting ? 'Creating...' : 'Create'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
