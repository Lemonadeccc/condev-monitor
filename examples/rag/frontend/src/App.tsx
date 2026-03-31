import { clearUser, setUser } from '@condev-monitor/monitor-sdk-browser'
import { Router } from '@/router'
import { App as AntdApp, ConfigProvider, Spin } from 'antd'
import zhCN from 'antd/es/locale/zh_CN'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSnapshot } from 'valtio'
import { userState } from './store/user'

function toMonitorUser(username?: string | null) {
  const normalized = username?.trim()
  if (!normalized) return null

  return normalized.includes('@')
    ? { id: normalized, email: normalized }
    : { id: normalized }
}

function App() {
  const { username } = useSnapshot(userState)

  useEffect(() => {
    const monitorUser = toMonitorUser(username)
    if (monitorUser) {
      setUser(monitorUser)
      return
    }
    clearUser()
  }, [username])

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        cssVar: true,
        token: {
          colorPrimary: '#1F70FE',
        },
      }}
    >
      <AntdApp>
        <Router />
        <MountApi />
      </AntdApp>
    </ConfigProvider>
  )
}

function MountApi() {
  window.$app = AntdApp.useApp()

  const [loading, setLoading] = useState(false)
  const [loadingText, setLoadingText] = useState('')
  const loadingCount = useRef(0)
  window.$showLoading = useCallback(({ title }: { title?: string } = {}) => {
    loadingCount.current++
    setLoading(true)
    setLoadingText(title ?? '')
  }, [])
  window.$hideLoading = useCallback(() => {
    loadingCount.current--
    setTimeout(() => {
      if (loadingCount.current <= 0) {
        setLoading(false)
        setLoadingText('')
      }
    }, 100)
  }, [])

  return (
    <>
      <Spin
        spinning={loading}
        tip={loadingText}
        fullscreen
        style={{
          zIndex: 9999999,
        }}
      ></Spin>
    </>
  )
}

export default App
