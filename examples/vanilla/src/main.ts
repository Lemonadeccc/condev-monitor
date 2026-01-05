import './style.css'

import { init } from '@condev-monitor/monitor-sdk-browser'
import { captureEvent, captureException, captureMessage } from '@condev-monitor/monitor-sdk-core'

import viteLogo from '/vite.svg'

import { setupCounter } from './counter.ts'
import typescriptLogo from './typescript.svg'

init({
    // target ip
    dsn: 'https://monitor.condevtools.com/dsn-api/tracking/vanilla28R8is',
})

function myFn() {
    throw new Error('This is a test error triggered by button click')
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
      <button id="caught-error-manual-btn" type="button" style="margin-left: 10px; background-color: #9c27b0;">Caught Error (manual)</button>
      <button id="custom-message-btn" type="button" style="margin-left: 10px; background-color: #607d8b;">Custom Message</button>
      <button id="custom-event-btn" type="button" style="margin-left: 10px; background-color: #4caf50;">Custom Event</button>
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
