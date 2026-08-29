'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BellRing, CheckCheck, Inbox, RefreshCw, RotateCcw, Save } from 'lucide-react'
import { useMemo, useState } from 'react'

import { AIPanelCard, AIStateMessage } from '@/components/ai/page-shell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatDateTime } from '@/lib/datetime'
import {
    canRetryLabNotificationDelivery,
    DEFAULT_LAB_NOTIFICATION_DESTINATION,
    labNotificationDeliveryExplanation,
    labNotificationDeliveryStateLabel,
    labNotificationDestinationBoundary,
    type LabNotificationDestinationForm,
    labNotificationDestinationKindLabel,
    validateLabNotificationDestinationForm,
} from '@/lib/lab-notification'
import type {
    LabAlertState,
    LabApiResponse,
    LabNotificationDeliveriesApiResponse,
    LabNotificationDestination,
    LabNotificationDestinationsApiResponse,
} from '@/types/lab'

const selectClassName =
    'h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, init)
    const body = (await response.json().catch(() => null)) as (T & { success?: boolean; message?: string }) | null
    if (!response.ok || !body || body.success === false) throw new Error(body?.message || '通知请求失败')
    return body
}

export function LabAlertAcknowledgementButton({ appId, alert }: { appId: string; alert: LabAlertState }) {
    const queryClient = useQueryClient()
    const mutation = useMutation({
        mutationFn: () =>
            request<
                LabApiResponse<{
                    stateId: string
                    acknowledged: boolean
                    acknowledgedAt: string | null
                    notificationCancellationState:
                        | 'not-applicable'
                        | 'cancelled-pending'
                        | 'delivery-in-flight'
                        | 'already-delivered'
                        | 'no-pending-delivery'
                }>
            >(
                alert.acknowledged
                    ? `/api/labs/alert-states/${encodeURIComponent(alert.stateId)}/acknowledgement?appId=${encodeURIComponent(appId)}`
                    : `/api/labs/alert-states/${encodeURIComponent(alert.stateId)}/acknowledgement`,
                alert.acknowledged
                    ? { method: 'DELETE' }
                    : {
                          method: 'PUT',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ appId }),
                      }
            ),
        onSuccess: async () => {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: ['lab-alert-states', appId] }),
                queryClient.invalidateQueries({ queryKey: ['lab-alert-acknowledgements', appId] }),
            ])
        },
    })

    return (
        <div className="mt-3 flex flex-wrap items-center gap-2">
            {alert.acknowledged ? <Badge variant="success">已确认</Badge> : <Badge variant="outline">尚未确认</Badge>}
            <Button size="sm" variant="outline" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
                <CheckCheck className="h-4 w-4" />
                {mutation.isPending ? '处理中…' : alert.acknowledged ? '清除确认' : '确认已知悉'}
            </Button>
            {mutation.error ? <span className="text-xs text-destructive">{mutation.error.message}</span> : null}
            {mutation.data?.data.notificationCancellationState === 'cancelled-pending' ? (
                <span className="text-xs text-muted-foreground">尚未开始的通知已取消。</span>
            ) : mutation.data?.data.notificationCancellationState === 'delivery-in-flight' ? (
                <span className="text-xs text-warning">通知已越过取消点，可能仍被远端接受。</span>
            ) : mutation.data?.data.notificationCancellationState === 'already-delivered' ? (
                <span className="text-xs text-muted-foreground">通知此前已被提供商接受，无法撤回。</span>
            ) : null}
        </div>
    )
}

export function LabNotificationManager({ appId }: { appId: string }) {
    const queryClient = useQueryClient()
    const encodedAppId = encodeURIComponent(appId)
    const destinationsQuery = useQuery({
        queryKey: ['lab-notification-destinations', appId],
        queryFn: () => request<LabNotificationDestinationsApiResponse>(`/api/labs/notification-destinations?appId=${encodedAppId}`),
    })
    const deliveriesQuery = useQuery({
        queryKey: ['lab-notification-deliveries', appId],
        queryFn: () => request<LabNotificationDeliveriesApiResponse>(`/api/labs/notification-deliveries?appId=${encodedAppId}`),
        refetchInterval: query =>
            query.state.data?.data.deliveries.some(delivery => ['pending', 'processing', 'retry'].includes(delivery.state)) ? 5_000 : false,
    })
    const destinations = useMemo(() => destinationsQuery.data?.data.destinations ?? [], [destinationsQuery.data?.data.destinations])
    const destinationsById = useMemo(
        () => new Map(destinations.map(destination => [destination.destinationId, destination])),
        [destinations]
    )

    const invalidate = async () => {
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: ['lab-notification-destinations', appId] }),
            queryClient.invalidateQueries({ queryKey: ['lab-notification-deliveries', appId] }),
        ])
    }

    return (
        <AIPanelCard
            title="策略通知与投递"
            description="通知由告警事件事务内写入 outbox，再在事务外处理。目的地不保存邮箱、URL 或 secret。"
            headerBorder
        >
            <div className="grid gap-6 xl:grid-cols-[minmax(20rem,0.8fr)_minmax(0,1.2fr)]">
                <DestinationEditor
                    appId={appId}
                    destinations={destinations}
                    loading={destinationsQuery.isLoading}
                    error={destinationsQuery.error}
                    onChanged={invalidate}
                />
                <DeliveryOutbox appId={appId} destinationsById={destinationsById} query={deliveriesQuery} onChanged={invalidate} />
            </div>
        </AIPanelCard>
    )
}

function DestinationEditor({
    appId,
    destinations,
    loading,
    error,
    onChanged,
}: {
    appId: string
    destinations: readonly LabNotificationDestination[]
    loading: boolean
    error: Error | null
    onChanged: () => Promise<void>
}) {
    const [values, setValues] = useState<LabNotificationDestinationForm>({ ...DEFAULT_LAB_NOTIFICATION_DESTINATION })
    const [selectedId, setSelectedId] = useState<string | null>(null)
    const [formError, setFormError] = useState<string | null>(null)
    const mutation = useMutation({
        mutationFn: (input: LabNotificationDestinationForm) =>
            request<LabApiResponse<LabNotificationDestination>>(
                `/api/labs/notification-destinations/${encodeURIComponent(input.destinationKey.trim())}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        appId,
                        kind: input.kind,
                        registryRevision: input.registryRevision,
                        enabled: input.enabled,
                        cooldownSeconds: input.cooldownSeconds,
                        maxAttempts: input.maxAttempts,
                    }),
                }
            ),
        onSuccess: onChanged,
    })
    const selectDestination = (destination: LabNotificationDestination) => {
        setSelectedId(destination.destinationId)
        setValues({
            destinationKey: destination.destinationKey,
            kind: destination.kind,
            registryRevision: destination.registryRevision,
            enabled: destination.enabled,
            cooldownSeconds: destination.cooldownSeconds,
            maxAttempts: destination.maxAttempts,
        })
        setFormError(null)
    }
    const reset = () => {
        setSelectedId(null)
        setValues({ ...DEFAULT_LAB_NOTIFICATION_DESTINATION })
        setFormError(null)
    }
    const submit = (event: React.FormEvent) => {
        event.preventDefault()
        const error = validateLabNotificationDestinationForm(values)
        setFormError(error)
        if (!error) mutation.mutate(values)
    }

    return (
        <div className="grid content-start gap-4">
            <div>
                <h3 className="flex items-center gap-2 text-sm font-medium">
                    <BellRing className="h-4 w-4" /> 通知目的地
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                    `local` 可完整本地验收；`owner-email` 复用邮件配置；`webhook` 只引用服务端 registry，不保存 URL 或 secret。
                </p>
            </div>
            {loading ? (
                <AIStateMessage>正在加载通知目的地…</AIStateMessage>
            ) : error ? (
                <AIStateMessage tone="destructive">{error.message || '通知目的地加载失败'}</AIStateMessage>
            ) : destinations.length ? (
                <div className="grid gap-2">
                    {destinations.map(destination => (
                        <button
                            key={destination.destinationId}
                            type="button"
                            onClick={() => selectDestination(destination)}
                            className="rounded-lg border p-3 text-left text-sm transition-colors hover:bg-muted/40"
                        >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <span className="font-medium">{destination.destinationKey}</span>
                                <Badge variant={destination.enabled ? 'success' : 'outline'}>
                                    {destination.enabled ? '已启用' : '已停用'}
                                </Badge>
                            </div>
                            <p className="mt-1 text-xs text-muted-foreground">
                                {labNotificationDestinationKindLabel(destination.kind)} · 冷却 {destination.cooldownSeconds}s · 最多{' '}
                                {destination.maxAttempts} 次
                            </p>
                            {destination.registryRevision ? (
                                <p className="mt-1 text-xs text-muted-foreground">registry {destination.registryRevision}</p>
                            ) : null}
                        </button>
                    ))}
                </div>
            ) : (
                <AIStateMessage>尚未配置通知目的地。</AIStateMessage>
            )}
            <form onSubmit={submit} className="grid gap-3 rounded-lg border bg-muted/20 p-4">
                <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{selectedId ? '编辑目的地' : '新增目的地'}</span>
                    {selectedId ? (
                        <Button type="button" size="sm" variant="ghost" onClick={reset}>
                            新增另一项
                        </Button>
                    ) : null}
                </div>
                <div className="grid gap-1.5">
                    <Label>目的地标识</Label>
                    <Input
                        value={values.destinationKey}
                        disabled={Boolean(selectedId)}
                        onChange={event => setValues(current => ({ ...current, destinationKey: event.target.value }))}
                    />
                </div>
                <div className="grid gap-1.5">
                    <Label>类型</Label>
                    <select
                        className={selectClassName}
                        value={values.kind}
                        disabled={Boolean(selectedId)}
                        onChange={event => {
                            const kind = event.target.value as LabNotificationDestinationForm['kind']
                            setValues(current => ({ ...current, kind, registryRevision: kind === 'webhook' ? 'v1' : null }))
                        }}
                    >
                        <option value="local">平台内本地记录</option>
                        <option value="owner-email">应用所有者邮箱</option>
                        <option value="webhook">签名 Webhook</option>
                    </select>
                    <p className="text-xs text-muted-foreground">{labNotificationDestinationBoundary(values.kind)}</p>
                </div>
                {values.kind === 'webhook' ? (
                    <div className="grid gap-1.5">
                        <Label>服务端 registry 版本</Label>
                        <Input
                            value={values.registryRevision ?? ''}
                            onChange={event => setValues(current => ({ ...current, registryRevision: event.target.value }))}
                        />
                        <p className="text-xs text-muted-foreground">
                            这里只填写非秘密版本号；URL 和 HMAC secret 必须由部署侧只读 secret registry 提供。
                        </p>
                    </div>
                ) : null}
                <div className="grid grid-cols-2 gap-3">
                    <div className="grid gap-1.5">
                        <Label>冷却时间（秒）</Label>
                        <Input
                            type="number"
                            min={0}
                            max={86_400}
                            step={1}
                            value={values.cooldownSeconds}
                            onChange={event => setValues(current => ({ ...current, cooldownSeconds: Number(event.target.value) }))}
                        />
                    </div>
                    <div className="grid gap-1.5">
                        <Label>最大尝试次数</Label>
                        <Input
                            type="number"
                            min={1}
                            max={10}
                            step={1}
                            value={values.maxAttempts}
                            onChange={event => setValues(current => ({ ...current, maxAttempts: Number(event.target.value) }))}
                        />
                    </div>
                </div>
                <label className="flex items-center gap-2 text-sm">
                    <input
                        type="checkbox"
                        checked={values.enabled}
                        onChange={event => setValues(current => ({ ...current, enabled: event.target.checked }))}
                    />
                    启用此目的地
                </label>
                {formError || mutation.error ? <p className="text-sm text-destructive">{formError || mutation.error?.message}</p> : null}
                <Button type="submit" disabled={mutation.isPending}>
                    <Save className="h-4 w-4" /> {mutation.isPending ? '正在保存…' : '保存目的地'}
                </Button>
            </form>
        </div>
    )
}

function DeliveryOutbox({
    appId,
    destinationsById,
    query,
    onChanged,
}: {
    appId: string
    destinationsById: ReadonlyMap<string, LabNotificationDestination>
    query: ReturnType<typeof useQuery<LabNotificationDeliveriesApiResponse>>
    onChanged: () => Promise<void>
}) {
    const retryMutation = useMutation({
        mutationFn: (deliveryId: string) =>
            request<LabApiResponse<unknown>>(`/api/labs/notification-deliveries/${encodeURIComponent(deliveryId)}/retry`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ appId }),
            }),
        onSuccess: onChanged,
    })
    const deliveries = query.data?.data.deliveries ?? []

    return (
        <div className="grid content-start gap-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h3 className="flex items-center gap-2 text-sm font-medium">
                        <Inbox className="h-4 w-4" /> 通知 outbox
                    </h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                        这里只显示闭集状态和结果码，不显示收件地址、URL、secret 或告警自由文本。
                    </p>
                </div>
                <Button size="sm" variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>
                    <RefreshCw className="h-4 w-4" /> {query.isFetching ? '刷新中…' : '刷新状态'}
                </Button>
            </div>
            {query.isLoading ? (
                <AIStateMessage>正在加载 outbox…</AIStateMessage>
            ) : query.isError ? (
                <AIStateMessage tone="destructive">{query.error?.message || 'outbox 加载失败'}</AIStateMessage>
            ) : deliveries.length ? (
                <div className="grid max-h-[38rem] gap-2 overflow-y-auto pr-1">
                    {deliveries.map(delivery => {
                        const destination = destinationsById.get(delivery.destinationId)
                        return (
                            <div key={delivery.deliveryId} className="rounded-lg border p-3 text-sm">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <span className="font-medium">{destination?.destinationKey ?? '历史目的地'}</span>
                                    <Badge
                                        variant={
                                            delivery.state === 'delivered'
                                                ? 'success'
                                                : delivery.state === 'quarantined'
                                                  ? 'destructive'
                                                  : delivery.state === 'suppressed'
                                                    ? 'warning'
                                                    : 'outline'
                                        }
                                    >
                                        {labNotificationDeliveryStateLabel(delivery.state)}
                                    </Badge>
                                </div>
                                <p className="mt-1 text-xs text-muted-foreground">{labNotificationDeliveryExplanation(delivery)}</p>
                                <p className="mt-2 text-xs text-muted-foreground">
                                    尝试 {delivery.attemptCount}/{delivery.maxAttempts} · 更新于 {formatDateTime(delivery.updatedAt)}
                                </p>
                                {canRetryLabNotificationDelivery(delivery.state) ? (
                                    <Button
                                        className="mt-3"
                                        size="sm"
                                        variant="outline"
                                        disabled={retryMutation.isPending}
                                        onClick={() => retryMutation.mutate(delivery.deliveryId)}
                                    >
                                        <RotateCcw className="h-4 w-4" /> 人工重试
                                    </Button>
                                ) : null}
                            </div>
                        )
                    })}
                </div>
            ) : (
                <AIStateMessage>还没有通知投递记录。告警发生后，启用的目的地会在同一事务内生成 outbox 项。</AIStateMessage>
            )}
            {retryMutation.error ? <p className="text-sm text-destructive">{retryMutation.error.message}</p> : null}
        </div>
    )
}
