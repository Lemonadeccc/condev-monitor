import { IPCService, PCAgent, PCDevice } from './src'

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function toBool(value?: string) {
    if (!value) return false
    return value === '1' || value.toLowerCase() === 'true'
}

function isOk(value: string) {
    return value.trim().toLowerCase().startsWith('ok')
}

function extractAppId(raw: string) {
    const text = String(raw || '').trim()
    if (!text) return null
    const labelMatch = text.match(/app id:\s*([a-z0-9_-]+)/i)
    if (labelMatch?.[1]) return labelMatch[1]
    const tokenMatch = text.match(/[a-z0-9_-]{6,}/i)
    return tokenMatch?.[0] ?? null
}

export async function testMonitorApp(pcService: IPCService) {
    const baseUrl = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '')
    const email = process.env.TEST_USER_EMAIL
    const password = process.env.TEST_USER_PASSWORD
    if (!email || !password) {
        throw new Error('Missing TEST_USER_EMAIL or TEST_USER_PASSWORD in environment.')
    }

    const preferManual = toBool(process.env.PREFER_MANUAL_SCREEN)
    const windowTitle = process.env.TARGET_WINDOW_TITLE
    const windowAppName = process.env.TARGET_APP_NAME
    const launchOptions = preferManual
        ? { screenArea: { preferManual: true } }
        : windowTitle || windowAppName
          ? { windowInfo: { title: windowTitle, appName: windowAppName } }
          : undefined

    const device = new PCDevice({
        pcService,
        launchOptions,
    })

    await device.launch()
    const agent = new PCAgent(device)

    try {
        await agent.ai(`Open ${baseUrl}/login in the browser.`)
        await agent.ai(
            `If you are not logged in, fill email "${email}" and password "${password}", then click "Login". If already logged in, skip.`
        )
        const loginCheck = await agent.aiOutput(
            'Is the main dashboard visible (Overview header or the left sidebar)? Reply only "ok" or "no".'
        )
        if (!isOk(loginCheck)) {
            throw new Error(`Login check failed: ${loginCheck}`)
        }

        const appName = `auto-${Date.now()}`
        await agent.ai(
            `Click "Create app", set "App name" to "${appName}", click "Create", and wait for the new card to appear.`
        )
        const appIdText = await agent.aiOutput(
            `In the card named "${appName}", read the value after "App ID:". Reply with only the value.`
        )
        const appId = extractAppId(appIdText)
        if (!appId) {
            throw new Error(`Could not parse App ID from: ${appIdText}`)
        }

        await agent.ai(`In the card named "${appName}", click the "App ID: ${appId}" button to copy the ID.`)
        await sleep(600)
        const clipboardText = await pcService.clipboard.getContent()
        const clipboardId = extractAppId(clipboardText)
        if (!clipboardId) {
            throw new Error(`Clipboard does not contain an App ID. Clipboard="${clipboardText}"`)
        }
        if (clipboardId !== appId) {
            throw new Error(`App ID mismatch. ui="${appId}" clipboard="${clipboardId}"`)
        }

        await agent.ai(
            `In the "${appName}" card, toggle Replay to ON and change the range dropdown to "1D".`
        )
        await agent.ai(`Open the gear menu on "${appName}", choose "Rename", then click "Cancel".`)

        await agent.ai('Click the left menu "Bugs" and wait for the page to load.')
        const bugsCheck = await agent.aiOutput('Is the "Bugs" page visible with an Issues section? Reply "ok" or "no".')
        if (!isOk(bugsCheck)) {
            throw new Error(`Bugs page check failed: ${bugsCheck}`)
        }
        await agent.ai('Open the Range dropdown and select "1H". Open Application dropdown and select the first app.')

        await agent.ai('Click the left menu "Metric" and wait for the page to load.')
        const metricCheck = await agent.aiOutput(
            'Is the "Metric" page visible with a "Performance events" chart? Reply "ok" or "no".'
        )
        if (!isOk(metricCheck)) {
            throw new Error(`Metric page check failed: ${metricCheck}`)
        }
        await agent.ai('Open the Range dropdown and select "3H". Open Application dropdown and select the first app.')

        await agent.ai('Click the left menu "Replays" and wait for the page to load.')
        const replaysCheck = await agent.aiOutput(
            'Is the "Replays" page visible (table or empty state)? Reply "ok" or "no".'
        )
        if (!isOk(replaysCheck)) {
            throw new Error(`Replays page check failed: ${replaysCheck}`)
        }
    } finally {
        await device.destroy()
    }
}
