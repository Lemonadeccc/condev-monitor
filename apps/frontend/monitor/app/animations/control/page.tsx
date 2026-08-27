'use client'

import { isAnimationRumV2RouteKey, isAnimationRumV2TargetKey } from '@condev-monitor/animation-rum-contract'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Boxes, Crosshair, Route as RouteIcon, Settings2, ShieldCheck } from 'lucide-react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { type FormEvent, useMemo, useState } from 'react'

import { AIMonitorHeader, AIMonitorPage, AIMonitorScopeActions, AIPanelCard, AIStatCard, AIStateMessage } from '@/components/ai/page-shell'
import { useAuth } from '@/components/providers'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useApplications } from '@/hooks/use-applications'
import { buildMonitorScopeHref, resolveMonitorAppId, useMonitorScope } from '@/hooks/use-monitor-scope'
import {
    AnimationRumV2ControlApiError,
    configureAnimationRumV2Policy,
    getAnimationRumV2ControlState,
    setAnimationRumV2DeploymentEnabled,
    setAnimationRumV2PolicyEnabled,
    setAnimationRumV2RouteEnabled,
    setAnimationRumV2TargetEnabled,
} from '@/lib/animation-rum-v2-control'
import { formatDateTime } from '@/lib/datetime'
import type {
    AnimationRumV2ControlState,
    AnimationRumV2DeploymentState,
    AnimationRumV2Policy,
    AnimationRumV2RouteState,
} from '@/types/animation-rum-v2-control'

const DEPLOYMENT_VALUE_PATTERN = /^(?:|[A-Za-z0-9][A-Za-z0-9._+-]{0,63})$/u

const DEFAULT_POLICY_LIMITS = {
    maxRoutes: 64,
    maxTargets: 512,
    maxDeployments: 32,
}

type WorkspaceControlAction = {
    execute: () => Promise<unknown>
    successMessage: string
    afterSuccess?: () => void
}

type ControlAction = WorkspaceControlAction & {
    appId: string
}

type RunControlAction = (action: WorkspaceControlAction) => void

class PartialControlActionError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'PartialControlActionError'
    }
}

function controlQueryKey(appId: string) {
    return ['animation-rum-v2-control', appId] as const
}

function apiErrorMessage(error: unknown): string {
    if (error instanceof AnimationRumV2ControlApiError) {
        return error.code ? `${error.message}（${error.code}）` : error.message
    }
    return error instanceof Error ? error.message : '操作失败，请稍后重试。'
}

function RegistryStatus({ enabled, effectiveEnabled }: { enabled: boolean; effectiveEnabled: boolean }) {
    return (
        <div className="flex flex-wrap gap-2">
            <Badge variant={enabled ? 'success' : 'outline'}>{enabled ? '自身启用' : '自身禁用'}</Badge>
            <Badge variant={effectiveEnabled ? 'success' : 'warning'}>{effectiveEnabled ? '实际生效' : '未生效'}</Badge>
        </div>
    )
}

function QuotaField({
    id,
    label,
    value,
    min,
    max,
    onChange,
    disabled,
    invalid,
    errorId,
}: {
    id: string
    label: string
    value: string
    min: number
    max: number
    onChange: (value: string) => void
    disabled: boolean
    invalid: boolean
    errorId: string
}) {
    return (
        <div className="space-y-2">
            <Label htmlFor={id}>{label}</Label>
            <Input
                id={id}
                type="number"
                inputMode="numeric"
                min={min}
                max={max}
                step={1}
                value={value}
                onChange={event => onChange(event.target.value)}
                disabled={disabled}
                aria-invalid={invalid || undefined}
                aria-describedby={invalid ? errorId : undefined}
            />
            <p className="text-xs text-muted-foreground">
                允许 {min}–{max}
            </p>
        </div>
    )
}

function PolicyForm({
    appId,
    policy,
    minimums,
    pending,
    runAction,
}: {
    appId: string
    policy: AnimationRumV2Policy | null
    minimums: { routes: number; targets: number; deployments: number }
    pending: boolean
    runAction: RunControlAction
}) {
    const [values, setValues] = useState(() => ({
        maxRoutes: String(policy?.maxRoutes ?? DEFAULT_POLICY_LIMITS.maxRoutes),
        maxTargets: String(policy?.maxTargets ?? DEFAULT_POLICY_LIMITS.maxTargets),
        maxDeployments: String(policy?.maxDeployments ?? DEFAULT_POLICY_LIMITS.maxDeployments),
    }))
    const [validationError, setValidationError] = useState<string | null>(null)

    const submit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        const maxRoutes = Number(values.maxRoutes)
        const maxTargets = Number(values.maxTargets)
        const maxDeployments = Number(values.maxDeployments)
        const minimumRoutes = Math.max(1, minimums.routes)
        const minimumTargets = Math.max(1, minimums.targets)
        const minimumDeployments = Math.max(1, minimums.deployments)
        const valid =
            Number.isInteger(maxRoutes) &&
            maxRoutes >= minimumRoutes &&
            maxRoutes <= 256 &&
            Number.isInteger(maxTargets) &&
            maxTargets >= minimumTargets &&
            maxTargets <= 2048 &&
            Number.isInteger(maxDeployments) &&
            maxDeployments >= minimumDeployments &&
            maxDeployments <= 512
        if (!valid) {
            setValidationError(
                `请填写范围内的整数；配额不能低于历史占用（路由 ${minimums.routes}、目标 ${minimums.targets}、部署 ${minimums.deployments}）。`
            )
            return
        }

        setValidationError(null)
        runAction({
            execute: () => configureAnimationRumV2Policy({ appId, maxRoutes, maxTargets, maxDeployments }),
            successMessage: policy ? '采集配额已更新。' : '采集策略已创建；当前仍处于禁用状态。',
        })
    }

    return (
        <form className="space-y-4" onSubmit={submit}>
            <div className="grid gap-4 sm:grid-cols-3">
                <QuotaField
                    id="rum-v2-max-routes"
                    label="路由上限"
                    value={values.maxRoutes}
                    min={Math.max(1, minimums.routes)}
                    max={256}
                    onChange={value => setValues(current => ({ ...current, maxRoutes: value }))}
                    disabled={pending}
                    invalid={Boolean(validationError)}
                    errorId="rum-v2-policy-error"
                />
                <QuotaField
                    id="rum-v2-max-targets"
                    label="目标上限（全应用）"
                    value={values.maxTargets}
                    min={Math.max(1, minimums.targets)}
                    max={2048}
                    onChange={value => setValues(current => ({ ...current, maxTargets: value }))}
                    disabled={pending}
                    invalid={Boolean(validationError)}
                    errorId="rum-v2-policy-error"
                />
                <QuotaField
                    id="rum-v2-max-deployments"
                    label="部署上限"
                    value={values.maxDeployments}
                    min={Math.max(1, minimums.deployments)}
                    max={512}
                    onChange={value => setValues(current => ({ ...current, maxDeployments: value }))}
                    disabled={pending}
                    invalid={Boolean(validationError)}
                    errorId="rum-v2-policy-error"
                />
            </div>
            {validationError ? (
                <p id="rum-v2-policy-error" className="text-sm text-destructive">
                    {validationError}
                </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" disabled={pending}>
                    {policy ? '保存配额' : '创建禁用策略'}
                </Button>
                <p className="text-xs text-muted-foreground">禁用注册项不会删除历史记录，也不会释放配额。</p>
            </div>
        </form>
    )
}

function DeploymentForm({ appId, pending, runAction }: { appId: string; pending: boolean; runAction: RunControlAction }) {
    const [release, setRelease] = useState('')
    const [dist, setDist] = useState('')
    const [environment, setEnvironment] = useState('')
    const [validationError, setValidationError] = useState<string | null>(null)

    const submit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        if (![release, dist, environment].every(value => DEPLOYMENT_VALUE_PATTERN.test(value))) {
            setValidationError('部署字段最多 64 位，只能使用字母、数字、点、下划线、加号和连字符。')
            return
        }
        setValidationError(null)
        runAction({
            execute: () => setAnimationRumV2DeploymentEnabled({ appId, release, dist, environment }, true),
            successMessage: release || dist || environment ? '部署已注册或重新启用。' : '默认部署已注册或重新启用。',
            afterSuccess: () => {
                setRelease('')
                setDist('')
                setEnvironment('')
            },
        })
    }

    return (
        <form className="grid gap-3 lg:grid-cols-[1fr_1fr_1fr_auto] lg:items-end" onSubmit={submit}>
            <div className="space-y-2">
                <Label htmlFor="rum-v2-release">Release</Label>
                <Input
                    id="rum-v2-release"
                    value={release}
                    maxLength={64}
                    onChange={event => setRelease(event.target.value)}
                    disabled={pending}
                    aria-invalid={Boolean(validationError) || undefined}
                    aria-describedby={validationError ? 'rum-v2-deployment-error' : undefined}
                />
            </div>
            <div className="space-y-2">
                <Label htmlFor="rum-v2-dist">Dist</Label>
                <Input
                    id="rum-v2-dist"
                    value={dist}
                    maxLength={64}
                    onChange={event => setDist(event.target.value)}
                    disabled={pending}
                    aria-invalid={Boolean(validationError) || undefined}
                    aria-describedby={validationError ? 'rum-v2-deployment-error' : undefined}
                />
            </div>
            <div className="space-y-2">
                <Label htmlFor="rum-v2-environment">Environment</Label>
                <Input
                    id="rum-v2-environment"
                    value={environment}
                    maxLength={64}
                    onChange={event => setEnvironment(event.target.value)}
                    disabled={pending}
                    aria-invalid={Boolean(validationError) || undefined}
                    aria-describedby={validationError ? 'rum-v2-deployment-error' : undefined}
                />
            </div>
            <Button type="submit" disabled={pending}>
                注册部署
            </Button>
            {validationError ? (
                <p id="rum-v2-deployment-error" className="text-sm text-destructive lg:col-span-4">
                    {validationError}
                </p>
            ) : null}
        </form>
    )
}

function RouteForm({ appId, pending, runAction }: { appId: string; pending: boolean; runAction: RunControlAction }) {
    const [routeKey, setRouteKey] = useState('')
    const [validationError, setValidationError] = useState<string | null>(null)

    const submit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        if (!isAnimationRumV2RouteKey(routeKey)) {
            setValidationError('请使用稳定语义路由标识：以小写字母开头，最多 96 位；不要包含订单号、长数字、UUID 或长哈希等高基数值。')
            return
        }
        setValidationError(null)
        runAction({
            execute: () => setAnimationRumV2RouteEnabled({ appId, routeKey }, true),
            successMessage: '路由已注册或重新启用。',
            afterSuccess: () => setRouteKey(''),
        })
    }

    return (
        <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={submit}>
            <div className="min-w-0 flex-1 space-y-2">
                <Label htmlFor="rum-v2-route-key">稳定路由标识</Label>
                <Input
                    id="rum-v2-route-key"
                    value={routeKey}
                    maxLength={96}
                    placeholder="home 或 gallery:detail"
                    onChange={event => setRouteKey(event.target.value)}
                    disabled={pending}
                    aria-invalid={Boolean(validationError) || undefined}
                    aria-describedby={validationError ? 'rum-v2-route-error' : 'rum-v2-route-help'}
                />
                <p id="rum-v2-route-help" className="text-xs text-muted-foreground">
                    示例：home、gallery:detail；不要直接使用 URL 参数或业务 ID。
                </p>
                {validationError ? (
                    <p id="rum-v2-route-error" className="text-sm text-destructive">
                        {validationError}
                    </p>
                ) : null}
            </div>
            <Button type="submit" disabled={pending}>
                注册路由
            </Button>
        </form>
    )
}

function TargetForm({
    appId,
    routes,
    pending,
    runAction,
}: {
    appId: string
    routes: AnimationRumV2RouteState[]
    pending: boolean
    runAction: RunControlAction
}) {
    const [routeKey, setRouteKey] = useState('')
    const [targetKey, setTargetKey] = useState('')
    const [validationError, setValidationError] = useState<string | null>(null)

    const submit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        if (!routes.some(route => route.routeKey === routeKey)) {
            setValidationError('请填写一个已经注册的路由标识。')
            return
        }
        if (!isAnimationRumV2TargetKey(targetKey)) {
            setValidationError('请使用稳定语义目标标识：以小写字母开头，最多 48 位；不要包含用户 ID、长数字、UUID 或长哈希等高基数值。')
            return
        }
        setValidationError(null)
        runAction({
            execute: () => setAnimationRumV2TargetEnabled({ appId, routeKey, targetKey }, true),
            successMessage: '目标已注册或重新启用。',
            afterSuccess: () => setTargetKey(''),
        })
    }

    return (
        <form className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={submit}>
            <div className="space-y-2">
                <Label htmlFor="rum-v2-target-route">已注册路由</Label>
                <Input
                    id="rum-v2-target-route"
                    list="rum-v2-route-options"
                    value={routeKey}
                    maxLength={96}
                    placeholder={routes[0]?.routeKey ?? '请先注册路由'}
                    onChange={event => setRouteKey(event.target.value)}
                    disabled={pending || routes.length === 0}
                    aria-invalid={Boolean(validationError) || undefined}
                    aria-describedby={validationError ? 'rum-v2-target-error' : undefined}
                />
                <datalist id="rum-v2-route-options">
                    {routes.map(route => (
                        <option key={route.routeKey} value={route.routeKey} />
                    ))}
                </datalist>
            </div>
            <div className="space-y-2">
                <Label htmlFor="rum-v2-target-key">稳定目标标识</Label>
                <Input
                    id="rum-v2-target-key"
                    value={targetKey}
                    maxLength={48}
                    placeholder="hero 或 product-card"
                    onChange={event => setTargetKey(event.target.value)}
                    disabled={pending || routes.length === 0}
                    aria-invalid={Boolean(validationError) || undefined}
                    aria-describedby={validationError ? 'rum-v2-target-error' : 'rum-v2-target-help'}
                />
                <p id="rum-v2-target-help" className="text-xs text-muted-foreground">
                    示例：hero、product-card；不要使用运行时生成的对象或用户标识。
                </p>
            </div>
            <Button type="submit" disabled={pending || routes.length === 0}>
                注册目标
            </Button>
            {validationError ? (
                <p id="rum-v2-target-error" className="text-sm text-destructive sm:col-span-3">
                    {validationError}
                </p>
            ) : null}
        </form>
    )
}

function deploymentName(deployment: AnimationRumV2DeploymentState): string {
    if (!deployment.release && !deployment.dist && !deployment.environment) return '默认部署（SDK 未填写版本上下文）'
    return [deployment.release || 'release —', deployment.dist || 'dist —', deployment.environment || 'environment —'].join(' · ')
}

function RegistryRow({
    title,
    detail,
    accessibleName = title,
    enabled,
    effectiveEnabled,
    updatedAt,
    pending,
    onToggle,
}: {
    title: string
    detail?: string
    accessibleName?: string
    enabled: boolean
    effectiveEnabled: boolean
    updatedAt: string
    pending: boolean
    onToggle: () => void
}) {
    return (
        <div className="rounded-lg border p-4 [contain-intrinsic-size:88px] [content-visibility:auto]">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                    <div className="break-all font-mono text-sm font-medium">{title}</div>
                    {detail ? <div className="mt-1 break-all text-xs text-muted-foreground">{detail}</div> : null}
                    <div className="mt-1 text-xs text-muted-foreground">更新于 {formatDateTime(updatedAt)}</div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <RegistryStatus enabled={enabled} effectiveEnabled={effectiveEnabled} />
                    <Button
                        type="button"
                        size="sm"
                        variant={enabled ? 'outline' : 'secondary'}
                        onClick={onToggle}
                        disabled={pending}
                        aria-label={`${enabled ? '禁用' : '重新启用'} ${accessibleName}`}
                    >
                        {enabled ? '禁用' : '重新启用'}
                    </Button>
                </div>
            </div>
        </div>
    )
}

function ShowMoreButton({ shown, total, onClick }: { shown: number; total: number; onClick: () => void }) {
    return shown < total ? (
        <Button type="button" variant="outline" onClick={onClick}>
            再显示 {Math.min(100, total - shown)} 条（共 {total} 条）
        </Button>
    ) : null
}

function ControlWorkspace({
    appId,
    state,
    pending,
    runAction,
}: {
    appId: string
    state: AnimationRumV2ControlState
    pending: boolean
    runAction: RunControlAction
}) {
    const [routeLimit, setRouteLimit] = useState(100)
    const [targetLimit, setTargetLimit] = useState(100)
    const [deploymentLimit, setDeploymentLimit] = useState(100)
    const policy = state.policy

    if (!policy) {
        return (
            <AIPanelCard title="先创建采集策略" description="创建策略只保存闭集配额，默认保持禁用；不会立即接收 RUM v2 数据。" headerBorder>
                <PolicyForm
                    appId={appId}
                    policy={null}
                    minimums={{
                        routes: state.counts.routes.total,
                        targets: state.counts.targets.total,
                        deployments: state.counts.deployments.total,
                    }}
                    pending={pending}
                    runAction={runAction}
                />
            </AIPanelCard>
        )
    }

    const defaultDeployment = state.deployments.find(deployment => !deployment.release && !deployment.dist && !deployment.environment)
    const quickSetupComplete = policy.enabled && defaultDeployment?.enabled === true
    const visibleRoutes = state.routes.slice(0, routeLimit)
    const visibleTargets = state.targets.slice(0, targetLimit)
    const visibleDeployments = state.deployments.slice(0, deploymentLimit)

    return (
        <>
            <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
                <AIStatCard
                    label="策略总开关"
                    value={policy.enabled ? '已启用' : '已禁用'}
                    description={policy.enabled ? '仍需部署和路由/目标链路同时生效' : '所有 v2 上报会被准入层拒绝'}
                />
                <AIStatCard
                    label="部署"
                    value={`${state.counts.deployments.effectiveEnabled} / ${state.counts.deployments.total}`}
                    description={`自身启用 ${state.counts.deployments.enabled}`}
                />
                <AIStatCard
                    label="路由"
                    value={`${state.counts.routes.effectiveEnabled} / ${state.counts.routes.total}`}
                    description={`自身启用 ${state.counts.routes.enabled}`}
                />
                <AIStatCard
                    label="目标"
                    value={`${state.counts.targets.effectiveEnabled} / ${state.counts.targets.total}`}
                    description={`自身启用 ${state.counts.targets.enabled}`}
                />
            </div>

            <AIPanelCard
                title="策略与安全启用"
                description="建议先注册部署，再启用总开关。SDK 未提供 release / dist / environment 时，必须使用默认部署。"
                headerBorder
                headerActions={
                    <Badge variant={policy.enabled ? 'success' : 'warning'}>{policy.enabled ? '策略已启用' : '策略已禁用'}</Badge>
                }
            >
                <div className="space-y-5">
                    <PolicyForm
                        key={`${appId}:${policy.maxRoutes}:${policy.maxTargets}:${policy.maxDeployments}`}
                        appId={appId}
                        policy={policy}
                        minimums={{
                            routes: state.counts.routes.total,
                            targets: state.counts.targets.total,
                            deployments: state.counts.deployments.total,
                        }}
                        pending={pending}
                        runAction={runAction}
                    />
                    <div className="flex flex-wrap items-center gap-3 border-t pt-5">
                        {!quickSetupComplete ? (
                            <Button
                                type="button"
                                onClick={() =>
                                    runAction({
                                        execute: async () => {
                                            let defaultDeploymentEnabled = false
                                            if (!defaultDeployment?.enabled) {
                                                await setAnimationRumV2DeploymentEnabled(
                                                    { appId, release: '', dist: '', environment: '' },
                                                    true
                                                )
                                                defaultDeploymentEnabled = true
                                            }
                                            try {
                                                if (!policy.enabled) await setAnimationRumV2PolicyEnabled({ appId }, true)
                                            } catch (error) {
                                                if (defaultDeploymentEnabled) {
                                                    throw new PartialControlActionError(
                                                        `默认部署已启用，但策略总开关启用失败；界面将刷新真实状态。${apiErrorMessage(error)}`
                                                    )
                                                }
                                                throw error
                                            }
                                        },
                                        successMessage: '默认部署与策略总开关已启用。',
                                    })
                                }
                                disabled={pending}
                            >
                                <ShieldCheck aria-hidden="true" />
                                一键启用默认 SDK 配置
                            </Button>
                        ) : null}
                        <Button
                            type="button"
                            variant={policy.enabled ? 'destructive' : 'outline'}
                            onClick={() =>
                                runAction({
                                    execute: () => setAnimationRumV2PolicyEnabled({ appId }, !policy.enabled),
                                    successMessage: policy.enabled ? '策略总开关已禁用。' : '策略总开关已启用。',
                                })
                            }
                            disabled={pending}
                        >
                            {policy.enabled ? '禁用策略总开关' : '仅启用策略总开关'}
                        </Button>
                        <p className="text-xs text-muted-foreground">
                            一键操作严格按“默认部署 → 策略”顺序执行；中途失败会停止并刷新真实状态。
                        </p>
                    </div>
                </div>
            </AIPanelCard>

            <AIPanelCard
                title="部署白名单"
                description={`历史占用 ${state.counts.deployments.total} / ${policy.maxDeployments}。三个空字段代表默认部署，不代表漏填。`}
                headerBorder
            >
                <div className="space-y-5">
                    <DeploymentForm appId={appId} pending={pending} runAction={runAction} />
                    <div className="space-y-3">
                        {visibleDeployments.length > 0 ? (
                            visibleDeployments.map(deployment => (
                                <RegistryRow
                                    key={`${deployment.release}\u0000${deployment.dist}\u0000${deployment.environment}`}
                                    title={deploymentName(deployment)}
                                    enabled={deployment.enabled}
                                    effectiveEnabled={deployment.effectiveEnabled}
                                    updatedAt={deployment.updatedAt}
                                    pending={pending}
                                    onToggle={() =>
                                        runAction({
                                            execute: () =>
                                                setAnimationRumV2DeploymentEnabled(
                                                    {
                                                        appId,
                                                        release: deployment.release,
                                                        dist: deployment.dist,
                                                        environment: deployment.environment,
                                                    },
                                                    !deployment.enabled
                                                ),
                                            successMessage: deployment.enabled ? '部署已禁用。' : '部署已重新启用。',
                                        })
                                    }
                                />
                            ))
                        ) : (
                            <p className="text-sm text-muted-foreground">尚未注册部署；任何 RUM v2 上报都不会通过准入。</p>
                        )}
                        <ShowMoreButton
                            shown={visibleDeployments.length}
                            total={state.deployments.length}
                            onClick={() => setDeploymentLimit(limit => limit + 100)}
                        />
                    </div>
                </div>
            </AIPanelCard>

            <AIPanelCard
                title="路由白名单"
                description={`历史占用 ${state.counts.routes.total} / ${policy.maxRoutes}。routeKey 是手工定义的稳定标识，不从 URL、文本或 selector 自动生成。`}
                headerBorder
            >
                <div className="space-y-5">
                    <RouteForm appId={appId} pending={pending} runAction={runAction} />
                    <div className="space-y-3">
                        {visibleRoutes.length > 0 ? (
                            visibleRoutes.map(route => (
                                <RegistryRow
                                    key={route.routeKey}
                                    title={route.routeKey}
                                    enabled={route.enabled}
                                    effectiveEnabled={route.effectiveEnabled}
                                    updatedAt={route.updatedAt}
                                    pending={pending}
                                    onToggle={() =>
                                        runAction({
                                            execute: () =>
                                                setAnimationRumV2RouteEnabled({ appId, routeKey: route.routeKey }, !route.enabled),
                                            successMessage: route.enabled ? '路由已禁用；其目标会变为未生效。' : '路由已重新启用。',
                                        })
                                    }
                                />
                            ))
                        ) : (
                            <p className="text-sm text-muted-foreground">尚未注册路由。未配置 routeKey 的页面级报告不需要路由白名单。</p>
                        )}
                        <ShowMoreButton
                            shown={visibleRoutes.length}
                            total={state.routes.length}
                            onClick={() => setRouteLimit(limit => limit + 100)}
                        />
                    </div>
                </div>
            </AIPanelCard>

            <AIPanelCard
                title="目标白名单"
                description={`历史占用 ${state.counts.targets.total} / ${policy.maxTargets}。目标必须依附已注册路由；目标自身启用不代表父路由或总策略已经生效。`}
                headerBorder
            >
                <div className="space-y-5">
                    <TargetForm appId={appId} routes={state.routes} pending={pending} runAction={runAction} />
                    <div className="space-y-3">
                        {visibleTargets.length > 0 ? (
                            visibleTargets.map(target => (
                                <RegistryRow
                                    key={`${target.routeKey}:${target.targetKey}`}
                                    title={target.targetKey}
                                    detail={`路由 ${target.routeKey}`}
                                    accessibleName={`${target.targetKey}，路由 ${target.routeKey}`}
                                    enabled={target.enabled}
                                    effectiveEnabled={target.effectiveEnabled}
                                    updatedAt={target.updatedAt}
                                    pending={pending}
                                    onToggle={() =>
                                        runAction({
                                            execute: () =>
                                                setAnimationRumV2TargetEnabled(
                                                    { appId, routeKey: target.routeKey, targetKey: target.targetKey },
                                                    !target.enabled
                                                ),
                                            successMessage: target.enabled ? '目标已禁用。' : '目标已重新启用。',
                                        })
                                    }
                                />
                            ))
                        ) : (
                            <p className="text-sm text-muted-foreground">尚未注册目标；页面级数据仍可独立采集。</p>
                        )}
                        <ShowMoreButton
                            shown={visibleTargets.length}
                            total={state.targets.length}
                            onClick={() => setTargetLimit(limit => limit + 100)}
                        />
                    </div>
                </div>
            </AIPanelCard>
        </>
    )
}

export default function AnimationRumV2ControlPage() {
    const { user, loading } = useAuth()
    const enabled = !loading && Boolean(user)
    const searchParams = useSearchParams()
    const queryClient = useQueryClient()
    const { selectedAppId, setSelectedAppId } = useMonitorScope('1d')
    const { listQuery } = useApplications({ enabled })
    const applications = useMemo(() => listQuery.data?.data?.applications ?? [], [listQuery.data?.data?.applications])
    const effectiveAppId = resolveMonitorAppId(applications, selectedAppId)
    const [notice, setNotice] = useState<{ appId: string; message: string } | null>(null)
    const [activeMutationAppId, setActiveMutationAppId] = useState<string | null>(null)

    const controlQuery = useQuery({
        queryKey: controlQueryKey(effectiveAppId),
        enabled: enabled && Boolean(effectiveAppId),
        queryFn: ({ signal }) => getAnimationRumV2ControlState(effectiveAppId, signal),
        refetchOnWindowFocus: false,
        retry: false,
    })

    const actionMutation = useMutation<unknown, Error, ControlAction>({
        mutationFn: action => action.execute(),
        onMutate: action => {
            setNotice(null)
            setActiveMutationAppId(action.appId)
        },
        onSuccess: (_data, action) => {
            action.afterSuccess?.()
            setNotice({ appId: action.appId, message: action.successMessage })
        },
        onSettled: async (_data, _error, action) => {
            await queryClient.invalidateQueries({ queryKey: controlQueryKey(action.appId) })
            setActiveMutationAppId(null)
        },
    })

    const runAction: RunControlAction = action => {
        if (!effectiveAppId || actionMutation.isPending) return
        actionMutation.mutate({ ...action, appId: effectiveAppId })
    }

    const changeApplication = (appId: string) => {
        if (actionMutation.isPending) return
        setNotice(null)
        actionMutation.reset()
        setSelectedAppId(appId)
    }

    const mutationTargetAppId = activeMutationAppId ?? actionMutation.variables?.appId ?? null
    const mutationTargetName = mutationTargetAppId
        ? (applications.find(application => application.appId === mutationTargetAppId)?.name ?? mutationTargetAppId)
        : null

    if (loading) return <div className="text-sm text-muted-foreground">正在加载…</div>
    if (!user) return null

    return (
        <AIMonitorPage>
            <AIMonitorHeader
                icon={Settings2}
                title="动效 RUM v2 · 采集设置"
                description="显式管理闭集配额和部署、路由、目标白名单；这里只控制生产上报准入，不影响页面内本地诊断面板。"
                actions={
                    <AIMonitorScopeActions
                        applications={applications}
                        appId={effectiveAppId || null}
                        onAppChange={changeApplication}
                        disabled={actionMutation.isPending}
                        extraActions={
                            actionMutation.isPending ? (
                                <Button type="button" variant="outline" size="sm" disabled>
                                    <ArrowLeft aria-hidden="true" />
                                    返回动效监控
                                </Button>
                            ) : (
                                <Button asChild variant="outline" size="sm">
                                    <Link href={buildMonitorScopeHref('/animations', searchParams)}>
                                        <ArrowLeft aria-hidden="true" />
                                        返回动效监控
                                    </Link>
                                </Button>
                            )
                        }
                    />
                }
            />

            <div className="grid gap-4 md:grid-cols-3">
                <AIPanelCard className="border-dashed" contentClassName="pt-4">
                    <div className="flex items-center gap-2 font-medium">
                        <Boxes className="h-4 w-4" aria-hidden="true" /> 部署
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">匹配 SDK 的 release、dist、environment；空三元组是明确的默认部署。</p>
                </AIPanelCard>
                <AIPanelCard className="border-dashed" contentClassName="pt-4">
                    <div className="flex items-center gap-2 font-medium">
                        <RouteIcon className="h-4 w-4" aria-hidden="true" /> 路由
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">只登记稳定业务标识，不保存 URL、selector、文本或用户输入。</p>
                </AIPanelCard>
                <AIPanelCard className="border-dashed" contentClassName="pt-4">
                    <div className="flex items-center gap-2 font-medium">
                        <Crosshair className="h-4 w-4" aria-hidden="true" /> 目标
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">目标依赖父路由；界面同时展示自身状态和完整链路的实际状态。</p>
                </AIPanelCard>
            </div>

            {actionMutation.isPending && mutationTargetName ? (
                <div className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm" role="status">
                    正在修改应用“{mutationTargetName}”的采集设置；完成前已锁定应用切换和返回操作。
                </div>
            ) : null}
            {actionMutation.isError ? (
                <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive" role="alert">
                    {mutationTargetName ? `应用“${mutationTargetName}”：` : ''}
                    {apiErrorMessage(actionMutation.error)}
                </div>
            ) : null}
            {notice && notice.appId === effectiveAppId ? (
                <div
                    className="rounded-lg border border-green-500/30 bg-green-500/5 px-4 py-3 text-sm text-green-700 dark:text-green-400"
                    role="status"
                >
                    {notice.message}
                </div>
            ) : null}

            {!effectiveAppId ? (
                <AIPanelCard>
                    <AIStateMessage>请先创建或选择一个应用。</AIStateMessage>
                </AIPanelCard>
            ) : controlQuery.isLoading ? (
                <AIPanelCard>
                    <AIStateMessage>正在读取采集控制状态…</AIStateMessage>
                </AIPanelCard>
            ) : controlQuery.isError ? (
                <AIPanelCard>
                    <AIStateMessage tone="destructive" className="space-y-3">
                        <p>{apiErrorMessage(controlQuery.error)}</p>
                        <Button type="button" variant="outline" size="sm" onClick={() => controlQuery.refetch()}>
                            重试
                        </Button>
                    </AIStateMessage>
                </AIPanelCard>
            ) : controlQuery.data ? (
                <ControlWorkspace
                    key={effectiveAppId}
                    appId={effectiveAppId}
                    state={controlQuery.data}
                    pending={actionMutation.isPending}
                    runAction={runAction}
                />
            ) : null}
        </AIMonitorPage>
    )
}
