// 获取浏览器的基本信息

export function getBrowserInfo() {
    return {
        userAgent: navigator.userAgent,
        language: navigator.language,
        platform: navigator.platform,
        rederrer: document.referrer,
        path: location.pathname,
    }
}

export { Metrics } from './integrations/metrics'
