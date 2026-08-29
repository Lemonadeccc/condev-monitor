import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
    canRetryLabNotificationDelivery,
    DEFAULT_LAB_NOTIFICATION_DESTINATION,
    labNotificationDeliveryExplanation,
    labNotificationDeliveryStateLabel,
    labNotificationDestinationBoundary,
    validateLabNotificationDestinationForm,
} from './lab-notification'

describe('Animation Lab notification presentation', () => {
    it('validates the same closed destination bounds as the backend', () => {
        assert.equal(validateLabNotificationDestinationForm({ ...DEFAULT_LAB_NOTIFICATION_DESTINATION }), null)
        assert.match(
            validateLabNotificationDestinationForm({ ...DEFAULT_LAB_NOTIFICATION_DESTINATION, destinationKey: 'bad key' }) ?? '',
            /目的地标识/u
        )
        assert.match(
            validateLabNotificationDestinationForm({ ...DEFAULT_LAB_NOTIFICATION_DESTINATION, cooldownSeconds: 86_401 }) ?? '',
            /86400/u
        )
        assert.match(validateLabNotificationDestinationForm({ ...DEFAULT_LAB_NOTIFICATION_DESTINATION, maxAttempts: 0 }) ?? '', /1 到 10/u)
    })

    it('never presents unavailable owner email as delivered', () => {
        assert.match(labNotificationDestinationBoundary('owner-email'), /没有可用邮件提供商/u)
        assert.equal(labNotificationDeliveryStateLabel('suppressed'), '已抑制（未投递）')
        assert.match(
            labNotificationDeliveryExplanation({ state: 'suppressed', lastResultCode: 'TRANSPORT_UNAVAILABLE' }),
            /没有邮件被发送/u
        )
    })

    it('requires an address-free server registry revision for webhook destinations', () => {
        assert.match(
            validateLabNotificationDestinationForm({
                ...DEFAULT_LAB_NOTIFICATION_DESTINATION,
                kind: 'webhook',
                registryRevision: null,
            }) ?? '',
            /registry/u
        )
        assert.equal(
            validateLabNotificationDestinationForm({
                ...DEFAULT_LAB_NOTIFICATION_DESTINATION,
                kind: 'webhook',
                registryRevision: 'v1',
            }),
            null
        )
        assert.match(labNotificationDestinationBoundary('webhook'), /HMAC secret/u)
    })

    it('distinguishes provider acceptance from final inbox receipt', () => {
        assert.match(labNotificationDeliveryExplanation({ state: 'delivered', lastResultCode: 'EMAIL_DELIVERED' }), /最终接收状态不在/u)
        assert.match(
            labNotificationDeliveryExplanation({ state: 'delivered', lastResultCode: 'WEBHOOK_ACCEPTED' }),
            /远端业务处理结果不在/u
        )
    })

    it('allows manual retry only for terminal recoverable states', () => {
        assert.equal(canRetryLabNotificationDelivery('suppressed'), true)
        assert.equal(canRetryLabNotificationDelivery('quarantined'), true)
        assert.equal(canRetryLabNotificationDelivery('cancelled'), false)
        assert.equal(canRetryLabNotificationDelivery('retry'), false)
        assert.equal(canRetryLabNotificationDelivery('delivered'), false)
    })

    it('presents acknowledgement cancellation as a terminal non-delivery', () => {
        assert.equal(labNotificationDeliveryStateLabel('cancelled'), '已取消')
        assert.match(labNotificationDeliveryExplanation({ state: 'cancelled', lastResultCode: 'ACKNOWLEDGED' }), /已取消/u)
    })

    it('presents lease loss as quarantine rather than successful delivery', () => {
        assert.match(labNotificationDeliveryExplanation({ state: 'quarantined', lastResultCode: 'LEASE_LOST' }), /隔离/u)
        assert.match(labNotificationDeliveryExplanation({ state: 'quarantined', lastResultCode: 'LEASE_RENEW_FAILED' }), /隔离/u)
    })
})
