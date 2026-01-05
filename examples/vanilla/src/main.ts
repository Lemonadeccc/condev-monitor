import './style.css'

import { init, triggerWhiteScreenCheck } from '@condev-monitor/monitor-sdk-browser'
import { captureEvent, captureException, captureMessage } from '@condev-monitor/monitor-sdk-core'

import viteLogo from '/vite.svg'

import { setupCounter } from './counter.ts'
import typescriptLogo from './typescript.svg'

init({
    // target ip
    dsn: 'https://monitor.condevtools.com/dsn-api/tracking/vanilla28R8is',
    whiteScreen: {
        runtimeWatch: true,
    },
    performance: {
        lowFpsThreshold: 55,
        lowFpsConsecutive: 1,
    },
})

function myFn() {
    throw new Error('This is a test error triggered by button click')
}

function blockMainThread(durationMs: number) {
    const start = performance.now()
    while (performance.now() - start < durationMs) {
        // busy loop
    }
}

let fpsStressRafId: number | null = null
function toggleFpsStress() {
    if (fpsStressRafId !== null) {
        cancelAnimationFrame(fpsStressRafId)
        fpsStressRafId = null
        return
    }

    const loop = () => {
        // Do some work each frame to intentionally drop FPS.
        blockMainThread(35)
        fpsStressRafId = requestAnimationFrame(loop)
    }
    fpsStressRafId = requestAnimationFrame(loop)
}

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div>
    <a href="https://vite.dev" target="_blank">
      <img src="${viteLogo}" class="logo" alt="Vite logo" />
    </a>
    <a href="https://www.typescriptlang.org/" target="_blank">
      <img src="${typescriptLogo}" class="logo vanilla" alt="TypeScript logo" />
    </a>
    <h1>Vite + TypeScript</h1>
    <div class="card">
      <button id="counter" type="button"></button>
      <button id="uncaught-error-btn" type="button" style="margin-left: 10px; background-color: #f44336;">Uncaught Error</button>
      <button id="uncaught-typeerror-btn" type="button" style="margin-left: 10px; background-color: #f44336;">Uncaught TypeError</button>
      <button id="uncaught-referenceerror-btn" type="button" style="margin-left: 10px; background-color: #f44336;">Uncaught ReferenceError</button>
    </div>
    <div class="card" style="padding-top: 0;">
      <button id="unhandledrejection-btn" type="button" style="background-color: #ff9800;">Unhandled Rejection</button>
      <button id="resource-error-btn" type="button" style="margin-left: 10px; background-color: #03a9f4;">Resource Load Error</button>
      <button id="caught-error-manual-btn" type="button" style="margin-left: 10px; background-color: #9c27b0;">Caught Error (manual)</button>
      <button id="custom-message-btn" type="button" style="margin-left: 10px; background-color: #607d8b;">Custom Message</button>
      <button id="custom-event-btn" type="button" style="margin-left: 10px; background-color: #4caf50;">Custom Event</button>
      <button id="white-screen-btn" type="button" style="margin-left: 10px; background-color: #ffffff; color: #111;">White Screen</button>
    </div>
    <div class="card" style="padding-top: 0;">
      <button id="route-change-btn" type="button" style="background-color: #2196f3;">Route: pushState</button>
      <button id="route-change-white-screen-btn" type="button" style="margin-left: 10px; background-color: #e91e63;">Route: pushState + White Screen</button>
    </div>
    <div class="card" style="padding-top: 0;">
      <button id="longtask-btn" type="button" style="background-color: #ff5722;">Long Task (200ms)</button>
      <button id="jank-btn" type="button" style="margin-left: 10px; background-color: #795548;">Jank (5s)</button>
      <button id="fps-btn" type="button" style="margin-left: 10px; background-color: #00bcd4;">Toggle FPS Stress</button>
    </div>
    <p class="read-the-docs">
      Click on the Vite and TypeScript logos to learn more
    </p>
  </div>
`

setupCounter(document.querySelector<HTMLButtonElement>('#counter')!)

document.querySelector<HTMLButtonElement>('#uncaught-error-btn')!.addEventListener('click', () => {
    myFn()
})

document.querySelector<HTMLButtonElement>('#uncaught-typeerror-btn')!.addEventListener('click', () => {
    ;(null as unknown as { call(): void }).call()
})

document.querySelector<HTMLButtonElement>('#uncaught-referenceerror-btn')!.addEventListener('click', () => {
    new Function('return notDeclaredVariable')()
})

document.querySelector<HTMLButtonElement>('#unhandledrejection-btn')!.addEventListener('click', () => {
    Promise.reject(new Error('Unhandled promise rejection from button click'))
})

document.querySelector<HTMLButtonElement>('#resource-error-btn')!.addEventListener('click', () => {
    const img = new Image()
    img.alt = 'broken image (for resource error test)'
    img.style.width = '64px'
    img.style.height = '64px'
    img.style.marginLeft = '10px'
    img.src = `/__condev_monitor_resource_error_test__.png?t=${Date.now()}`
    document.querySelector<HTMLDivElement>('#app')!.appendChild(img)
})

document.querySelector<HTMLButtonElement>('#caught-error-manual-btn')!.addEventListener('click', () => {
    try {
        throw new Error('Caught error (will not trigger window.onerror)')
    } catch (error) {
        captureException(error instanceof Error ? error : new Error(String(error)))
    }
})

document.querySelector<HTMLButtonElement>('#custom-message-btn')!.addEventListener('click', () => {
    captureMessage('Custom message from vanilla button click')
})

document.querySelector<HTMLButtonElement>('#custom-event-btn')!.addEventListener('click', () => {
    captureEvent({
        eventType: 'button_click',
        data: {
            source: 'vanilla',
            at: Date.now(),
            path: window.location.pathname,
        },
    })
})

document.querySelector<HTMLButtonElement>('#white-screen-btn')!.addEventListener('click', () => {
    const app = document.querySelector<HTMLDivElement>('#app')
    if (app) {
        app.innerHTML = ''
        app.style.minHeight = '100vh'
        app.style.width = '100vw'
        app.style.padding = '0'
    }
    document.documentElement.style.backgroundColor = '#ffffff'
    document.body.style.backgroundColor = '#ffffff'
    document.body.style.color = '#111111'

    triggerWhiteScreenCheck('vanilla-button')
})

document.querySelector<HTMLButtonElement>('#route-change-btn')!.addEventListener('click', () => {
    history.pushState({}, '', `/route-test-${Date.now()}`)

    // Create a small visible DOM mutation so MutationObserver path can run a non-white-screen check.
    const status = document.createElement('div')
    status.style.marginTop = '12px'
    status.style.fontSize = '12px'
    status.style.opacity = '0.7'
    status.textContent = `route changed to: ${window.location.pathname}`
    document.querySelector<HTMLDivElement>('#app')!.appendChild(status)
})

document.querySelector<HTMLButtonElement>('#route-change-white-screen-btn')!.addEventListener('click', () => {
    history.pushState({}, '', `/route-white-screen-${Date.now()}`)

    // Simulate route-render failure: DOM becomes blank after route change.
    const app = document.querySelector<HTMLDivElement>('#app')
    if (app) {
        app.innerHTML = ''
        app.style.minHeight = '100vh'
        app.style.width = '100vw'
        app.style.padding = '0'
    }
    document.documentElement.style.backgroundColor = '#ffffff'
    document.body.style.backgroundColor = '#ffffff'
    document.body.style.color = '#111111'
})

document.querySelector<HTMLButtonElement>('#longtask-btn')!.addEventListener('click', () => {
    blockMainThread(200)
})

document.querySelector<HTMLButtonElement>('#jank-btn')!.addEventListener('click', () => {
    const startedAt = Date.now()
    const timer = window.setInterval(() => {
        blockMainThread(150)
        if (Date.now() - startedAt > 5000) {
            window.clearInterval(timer)
        }
    }, 500)
})

document.querySelector<HTMLButtonElement>('#fps-btn')!.addEventListener('click', () => {
    toggleFpsStress()
})
