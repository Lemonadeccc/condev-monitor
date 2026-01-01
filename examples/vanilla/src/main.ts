import './style.css'

import { init } from '@condev-monitor/monitor-sdk-browser'

import viteLogo from '/vite.svg'

import { setupCounter } from './counter.ts'
import typescriptLogo from './typescript.svg'

// const monitoring =
init({
    // dsn: 'http://192.168.158.81:8080/appid-xxx',
    dsn: 'http://192.168.158.81:8080/tracking/vanilla28R8is',
})
// document.addEventListener('click', () => {
//     monitoring.reportEvent({ type: 'click' })
//     monitoring.reportMessage('event')
// })
// myFn()

// Promise.reject('test')

// 定义会抛出错误的函数，用于测试监控SDK
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
      <button id="error-btn" type="button" style="margin-left: 10px; background-color: #f44336;">触发错误</button>
    </div>
    <p class="read-the-docs">
      Click on the Vite and TypeScript logos to learn more
    </p>
  </div>
`

setupCounter(document.querySelector<HTMLButtonElement>('#counter')!)

document.querySelector<HTMLButtonElement>('#error-btn')!.addEventListener('click', () => {
    myFn()
})
