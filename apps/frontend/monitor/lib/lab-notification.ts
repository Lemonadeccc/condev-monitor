import type { LabNotificationDelivery, LabNotificationDeliveryState, LabNotificationDestinationKind } from '@/types/lab'

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,119}$/
const SAFE_REVISION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export type LabNotificationDestinationForm = {
    destinationKey: string
    kind: LabNotificationDestinationKind
    registryRevision: string | null
    enabled: boolean
    cooldownSeconds: number
    maxAttempts: number
}

export const DEFAULT_LAB_NOTIFICATION_DESTINATION: Readonly<LabNotificationDestinationForm> = Object.freeze({
    destinationKey: 'local-audit',
    kind: 'local',
    registryRevision: null,
    enabled: true,
    cooldownSeconds: 900,
    maxAttempts: 3,
})

export function validateLabNotificationDestinationForm(values: LabNotificationDestinationForm): string | null {
    if (!SAFE_KEY.test(values.destinationKey.trim())) return '目的地标识只能包含字母、数字、点、下划线、冒号、加号或连字符。'
    const hasValidRevision = Boolean(values.registryRevision && SAFE_REVISION.test(values.registryRevision))
    if (values.kind === 'webhook' && !hasValidRevision) return 'Webhook 必须填写有效的服务端 registry 版本。'
    if (values.kind !== 'webhook' && values.registryRevision !== null) return '只有 Webhook 可以设置 registry 版本。'
    if (!Number.isInteger(values.cooldownSeconds) || values.cooldownSeconds < 0 || values.cooldownSeconds > 86_400) {
        return '冷却时间必须是 0 到 86400 秒之间的整数。'
    }
    if (!Number.isInteger(values.maxAttempts) || values.maxAttempts < 1 || values.maxAttempts > 10) {
        return '最大尝试次数必须是 1 到 10 之间的整数。'
    }
    return null
}

export function labNotificationDestinationKindLabel(kind: LabNotificationDestinationKind): string {
    if (kind === 'local') return '平台内本地记录'
    if (kind === 'owner-email') return '应用所有者邮箱'
    return '签名 Webhook'
}

export function labNotificationDestinationBoundary(kind: LabNotificationDestinationKind): string {
    if (kind === 'local') return '只在平台 outbox 中记录结果，不会向站外发送内容。'
    if (kind === 'owner-email') {
        return '复用平台已有 SMTP 或 Resend 配置发送给应用所有者；没有可用邮件提供商时会安全抑制为“未投递”。'
    }
    return 'URL 与 HMAC secret 只存在服务端只读 registry；平台仅保存别名和不可变版本，拒绝重定向和内网地址。'
}

export function labNotificationDeliveryStateLabel(state: LabNotificationDeliveryState): string {
    if (state === 'pending') return '等待处理'
    if (state === 'processing') return '处理中'
    if (state === 'retry') return '等待重试'
    if (state === 'delivered') return '已记录'
    if (state === 'suppressed') return '已抑制（未投递）'
    if (state === 'cancelled') return '已取消'
    return '已隔离'
}

export function labNotificationDeliveryExplanation(delivery: Pick<LabNotificationDelivery, 'state' | 'lastResultCode'>): string {
    if (delivery.lastResultCode === 'ACKNOWLEDGED') return '告警已由使用者确认，待投递通知已取消。'
    if (delivery.lastResultCode === 'STATE_CHANGED') return '告警状态已经变化，旧状态的待投递通知已取消。'
    if (delivery.lastResultCode === 'LEASE_LOST') return '投递 worker 已失去该任务的 lease，结果已隔离等待核对。'
    if (delivery.lastResultCode === 'LEASE_RENEW_FAILED') return '投递 lease 无法续期，结果已隔离等待核对。'
    if (delivery.lastResultCode === 'EMAIL_DELIVERED') return '邮件提供商已接受发送请求；收件箱最终接收状态不在当前回执范围内。'
    if (delivery.lastResultCode === 'WEBHOOK_ACCEPTED') return 'Webhook 端点已接受签名请求；远端业务处理结果不在当前回执范围内。'
    if (delivery.lastResultCode === 'REGISTRY_REVISION_UNAVAILABLE') return '服务端没有匹配的 Webhook registry 版本，已安全抑制。'
    if (delivery.lastResultCode === 'WEBHOOK_REJECTED') return 'Webhook 返回不可重试的响应，已隔离等待人工检查。'
    if (delivery.lastResultCode === 'TRANSPORT_UNAVAILABLE') return '未配置真实邮件传输，已 fail-closed 安全抑制；没有邮件被发送。'
    if (delivery.lastResultCode === 'COOLDOWN_ACTIVE') return '同一告警仍在冷却窗口内，本次通知未投递。'
    if (delivery.lastResultCode === 'DELIVERY_FAILED') {
        return delivery.state === 'quarantined' ? '达到最大重试次数，已隔离等待人工检查。' : '投递失败，正在按退避计划重试。'
    }
    if (delivery.lastResultCode === 'LOCAL_RECORDED') return '已在平台内记录；这不是站外邮件或 Webhook 投递。'
    return '尚无投递结果。'
}

export function canRetryLabNotificationDelivery(state: LabNotificationDeliveryState): boolean {
    return state === 'suppressed' || state === 'quarantined'
}
