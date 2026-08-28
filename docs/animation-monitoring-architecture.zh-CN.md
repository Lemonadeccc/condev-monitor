# 动画性能监控：开发位置与数据边界

这份文档固定 Condev Monitor 动画监控的代码归属。目标是让本地开发诊断、生产 RUM 和浏览器 DevTools 共用同一套采集语义，同时避免把完整本地报告上传到生产环境。

## 一套核心，四个使用入口

| 使用方式         | 面向谁       | 在哪里开发                                                                | 数据去向                                      |
| ---------------- | ------------ | ------------------------------------------------------------------------- | --------------------------------------------- |
| 页面内本地诊断   | 开发人员     | `packages/animation` 的 collector、recommendations 和 `dev-overlay`       | 当前页面内存；默认不上传                      |
| 生产 SDK / RUM   | 线上用户页面 | `packages/animation` 的 RUM projection；复用 `packages/browser` transport | DSN → Kafka/Worker → ClickHouse → Monitor API |
| Labs 受控实验    | 开发/CI      | `packages/animation-lab`、`apps/backend/lab-runner`、平台 `/labs`         | 原始产物本地；有界脱敏摘要可上传 Monitor      |
| F12 / 浏览器插件 | 开发人员     | 后续独立 `apps/frontend/animation-devtools-extension`                     | 读取同一 collector/report；默认不上传         |

浏览器插件只是新的展示和调试入口，不拥有另一套 FPS、Long Task 或框架指标实现。这样页面浮层、自动化测试、移动端远程调试和浏览器插件得到的指标含义保持一致。

Labs 不是要求真实用户打开 DevTools 的功能。它是一个从命令行启动的浏览器中立 runner，当前 Playwright adapter 支持 Chromium、Firefox 和 WebKit：三个引擎都能按本地 JSON 场景重复执行 pointer、hover、click、scroll、drag、keyboard、resize 等动作并运行页面 probe；每条 `PerformanceObserver` 信号仍以浏览器 `supportedEntryTypes` 的精确声明为能力边界，浏览器静默接受未知 type 不算支持，因此 Firefox/WebKit 当前没有的 Long Task、LoAF、CLS 信号会保持 `unsupported`，不会伪装成测得的 0。CDP Performance trace 和 Lighthouse navigation 只在 Chromium 中可用。Chrome Network 面板的 “Preserve log/保留日志” 从不参与采集；页面 SDK 由 transport、离线队列和生命周期 flush 负责生产上报，Labs 由 runner 直接写本地产物并用授权 API 上传脱敏派生结果。

## 推荐接入：一次 init

同时需要普通 Browser 监控与动画监控的页面使用同一个入口：

```ts
import { init } from '@condev-monitor/monitor-sdk-browser/animation'

const client = init({
    dsn: import.meta.env.VITE_MONITOR_DSN || undefined,
    animation: {
        devtools: import.meta.env.DEV,
        rum: import.meta.env.VITE_MONITOR_DSN ? { sampleRate: 0.1 } : false,
        context: { routeKey: 'home', runtimeFamily: 'react' },
    },
})
```

有 DSN 时，错误、Web Vitals、Long Task/FPS、白屏与 animation RUM 共用一个 client、队列和 transport；没有 DSN 时只运行本地动画 collector/浮层，不创建 transport。动画 RUM 即使存在 DSN 也默认关闭，必须显式给 `sampleRate`；`routeKey` 必须由应用提供已经脱敏的稳定标识，SDK 不从 URL 推导。普通 Browser-only 页面继续使用 `@condev-monitor/monitor-sdk-browser`，不承担动画运行体积。

`client.animation.createFrameworkProbe()`、`createGsapProbe()`、`createThreeProbe()`、`createVideoProbe()` 只是在同一 collector 上补宿主证据，不会第二次 init，也不会创建第二个 rAF。Browser handle 也显式提供 `createGsapTickerObserver()`、`createLenisScrollObserver()` 和 `createScrollTriggerObserver()`：调用方仍须传入真实宿主实例并自行 `start()`，Browser 只统一尝试销毁，既不扫描全局对象，也不把这些 standalone snapshot 自动写入 host/RUM。Browser animation 入口默认开启隐私安全的粗粒度 load、pointer/click、真实 scroll、仅 fine pointer 的 hover/pointer-motion、keyboard、window resize 与 VisualViewport resize/pan 窗口；`autoInputWindows: false` 可以整体关闭，对象配置可以逐项关闭或调整有界 quiet period。自动窗口只保留 SDK 固定标签和时间边界，不保留坐标、按键值、selector、元素文字、输入值或原始事件，也不会捏造 input-to-visual、pointer sample age、progress/settle 或 GPU 数据。它们不能冒充业务动画已经完成；真实业务边界仍应调用 `client.animation.beginInteraction()`，独立测得的质量再通过 `recordQuality()` 写入。

同一个 Browser 入口现在还默认启动有界的本地 `snapshot.pageEvidence`：整页匿名 CSS/Web Animations 清单与生命周期计数、页面 video 的 RVFC/playback-quality probe、SVG/Canvas 表面数量、未来成功 `getContext()` 的 Canvas2D/WebGL/WebGL2/WebGPU 分类，以及 hidden/offscreen/reduced-motion 复核候选。自动 video probe 以 250–1,000 ms 的有界节奏聚合，不会每个解码回调都写一条 host sample。`autoPageEvidence: false` 可整体关闭，对象配置可分别关闭 `animations/media/rendererSurfaces/visibility/reducedMotion` 并调整采样和容量。它绝不保存动画名、selector、文字、属性值、keyframe、URL/src、坐标、按键、输入值或原始事件。页面只能把“隐藏时仍为 running”“离屏 target 仍为 running”“reduce 下仍存在运动”写成 candidate，不能证明实际执行了可避免工作或构成无障碍违规；普通 Canvas 表面也不能证明 draw call、GPU time、框架 owner 或业务完成。上述字段只存在本地 Browser snapshot，不进入 `animation_rum` v1。

## 第一版已经覆盖什么

当前第一版是“浏览器标准核心”，不是宣称一次完成所有框架内部归因：

- 已实现：可见 rAF frame tail、刷新率预算、慢帧、missed-display、burst、LoAF（含可选 PaintTimingMixin 的 render→paint / paint→presentation 本地证据）、Long Task、Event Timing 三阶段、语义 interaction、12-family coverage、监控自身回调开销、本地建议和 Shadow DOM overlay；
- 已实现：`captureSufficiency` 的 5 秒可见窗口、30 个保留帧、低置信度与截断门槛，并分别记录 visible/hidden/other duration；
- 已实现：共享的 document-lifetime CLS/INP/LCP 运行时、脱敏本地 latest snapshot，以及连续交互 `recordQuality` 的闭集字段、边界、丢样和拒绝统计；
- 已实现：默认整页匿名 CSS/WAAPI 清单、video RVFC、SVG/Canvas/已观察 context family、hidden/offscreen/reduced-motion 候选；页面 collector 始终运行时的并行 DOM Picker/目标 sidecar；Target 的 Start/Stop/Reset/Clear；属性候选、连接/尺寸、Canvas 分轴 backing scale/resize，以及 renderer evidence/GPU fail-closed 公共契约；
- 已实现：显式且稳定的 production sampling、匿名 `animation_rum` v1、严格 DSN/Worker 双重校验、独立 ClickHouse 表、JWT + application ownership 查询和 `/animations` 控制台；
- 已实现本地 capture-window Resource Timing 聚合，以及 framework/renderer/lifecycle/work/media 五类有界 host evidence sink；已提供 React Profiler/manual commit、独立 framework lifecycle update-window 与 component check-window、通用 renderer-host、Three `renderer.info`、GSAP/ScrollTrigger public API 和 Video RVFC/playback-quality helper，并落地 React、Vue、Angular、Svelte 与 Solid 框架入口；
- 已实现首版受控 Labs：Chromium/Firefox/WebKit 通用动作与页面 probe、重复 warmup/measured 场景、Chromium 独立 CDP trace 和 Lighthouse、原始产物本地保存，以及有界脱敏 timeline/report 上传；平台 `/labs` 展示 Overview、Animation、Performance、Lighthouse 与 Artifacts；
- 下一阶段继续补 Solid 深层 computation/why-update、Angular partial-compiled directive/APF 与 20/21/22 AOT consumer 矩阵、React/Vue/Angular/Svelte 深层 owner/why-update、renderer 资源/传输与内部对象归因、heap/route soak、decode/upload/first-visible 等深层证据；Angular 当前已提供 decorator-free target binding 与 app-local directive 配方，但不会把普通 `tsup` 装饰器转译伪称为可发布 AOT 指令；
- 后续再开发 Chrome DevTools extension、source map 到 authored source 的离线解析、WebDriver BiDi/Selenium/Grid adapter 与真实设备矩阵；这些不会替代已经落地的页面浮层或 Labs。

同一浏览器标准核心可用于原生页面及 React、Vue、Angular、Svelte、Solid 等 Web 框架，也能在支持相同 API 的 WebView 中降级运行。它不能凭浏览器 API 猜出 React commit、Vue update、Three draw call、GPU timer 或 native React Native 动画；这些数据必须由宿主 adapter 显式提供，并继续输出同一个有界合同。`unsupported` 或 `not-instrumented` 就是正确结果，不能为追求“全支持”而填 0。

## 本地 host evidence API 与边界

`AnimationCollector` 与 `AnimationIntegration` 都可以作为闭集 sink，公开相同的五个方法：

| 方法                     | 输入语义                                                                                                                                       | 会影响的 coverage（最多）                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `recordFrameworkStats()` | framework、mount/update/check/hydrate phase、render/base-render、独立测得的 commit duration、lifecycle update window 或 component check window | 本地 framework work；不单独改变 `workAvoidance`  |
| `recordRenderStats()`    | 通用/Three 闭集 counters 与 fail-closed GPU timer evidence                                                                                     | `renderer: partial`                              |
| `recordLifecycleStats()` | 明确 checkpoint 上的 GSAP animation / ScrollTrigger inventory                                                                                  | `memoryLifecycle: partial`                       |
| `recordWorkStats()`      | 宿主实测的 script/layout/paint/composite/other duration                                                                                        | 本地 work 明细；不单独证明 avoidable/hidden work |
| `recordMediaStats()`     | RVFC cadence/presentation timing 与 playback-quality delta                                                                                     | `resourcesMedia: partial`                        |

每个 family 默认保留 256 个、最多 4,096 个 sample。collector 忽略调用方的采集时钟并使用自己的单调 capture time；无效、非有限、越界或内部矛盾的样本会拒绝，ring 丢样保持显式。摘要固定在 `snapshot.hostEvidence.scope: 'capture-window-local'`，分别给出 accepted/retained/dropped/rejected/evidence sample：`acceptedWindow` 是全量 accepted 的时间跨度，`window`、分位数、分类计数和 delta total 只描述 retained bounded tail（`detailScope: 'retained-samples'`）；发生截断时不能把 tail 冒充全窗。接口没有任意 family、任意 metadata 或 custom payload 通道。

核心包导出以下无宿主依赖 helper：

```ts
import {
    AnimationCollector,
    createFrameworkCommitProbe,
    createGsapLifecycleCycleAnalyzer,
    createGsapLifecycleProbe,
    createGsapTickerObserver,
    createLenisScrollObserver,
    createRendererHostProbe,
    createScrollTriggerObserver,
    createThreeRendererProbe,
    createVideoFrameProbe,
} from '@condev-monitor/monitor-sdk-animation'
import { createWebGlGpuTimer } from '@condev-monitor/monitor-sdk-animation-renderer'

const animation = new AnimationCollector()
animation.start()

const framework = createFrameworkCommitProbe({ sink: animation, framework: 'react' })
// React: <Profiler onRender={framework.onReactProfilerRender}>…</Profiler>

const gpuTimer = createWebGlGpuTimer({
    gl,
    backend: 'webgl2',
    disjointQueryOwnership: 'exclusive',
})

const rendererHost = createRendererHostProbe({
    sink: animation,
    backend: 'webgl2', // canvas2d | webgl | webgl2 | webgpu | unknown
    read: () => ({
        drawCalls: publicRendererStats.drawCalls,
        triangles: publicRendererStats.triangles,
        contextLost: gl.isContextLost(),
        gpu: gpuTimer.takeLatestEvidence(), // 一次性读取已异步完成的结果
    }),
})
rendererHost.capture()

const three = createThreeRendererProbe({
    sink: animation,
    renderer,
    backend: 'webgl2',
    readGpuTiming: () => gpuTimer.takeLatestEvidence(),
})

function renderFrame() {
    gpuTimer.poll()
    const measuring = gpuTimer.beginFrame()
    try {
        renderer.render(scene, camera)
    } finally {
        if (measuring) gpuTimer.endFrame()
    }
    rendererHost.capture() // 或 three.capture()；同一结果不能消费两次
}

const gsapLifecycle = createGsapLifecycleProbe({ sink: animation, gsap, scrollTrigger: ScrollTrigger })
const gsapCycles = createGsapLifecycleCycleAnalyzer({ minimumCycles: 3 })
gsapCycles.record(gsapLifecycle.capture('mount'))
gsapCycles.record(gsapLifecycle.capture('after-interaction'))
gsapCycles.record(gsapLifecycle.capture('unmount'))
// 在相同 route/build/input/waits/cleanup 下至少重复三次，再读取：
const gsapGrowthCandidate = gsapCycles.snapshot()

const gsapTickerCadence = createGsapTickerObserver({
    ticker: gsap.ticker,
    // 阈值必须由应用声明；SDK 不把某个刷新率当成通用 GSAP 标准。
    slowTickThresholdMs: 1000 / 30,
})
gsapTickerCadence.start()
const localTickerTrend = gsapTickerCadence.snapshot()

const lenisScroll = createLenisScrollObserver({ lenis })
lenisScroll.start()
const localLenisTrend = lenisScroll.snapshot()

const scrollTriggerState = createScrollTriggerObserver({ scrollTrigger: ScrollTrigger })
scrollTriggerState.start()
// 手动 checkpoint；六类 public global event 也会自动生成有界 checkpoint。
const localScrollTriggerTrend = scrollTriggerState.capture()

const videoFrames = createVideoFrameProbe({ sink: animation, video })
videoFrames.start()
```

上例的 `animation` 可以是已经 `start()` 的 `AnimationCollector`，也可以是已经完成 client `setup()` 并处于 running 的 `AnimationIntegration`；collector 未运行时五个 `record*` 方法都会返回 `false`。这些 helper 只读取调用方显式交给它们的公开能力；`packages/animation` 不 import React、Three、GSAP 或 ScrollTrigger，不 monkey-patch 框架，也不扫描框架私有 hook。它们不会自动创建 `beginInteraction()` 业务窗口；需要业务级关联时，应用仍须在代表动作周围显式创建 interaction/quality window。它们也不创建、播放、暂停、kill 或 dispose 业务动画/renderer/video；应用拥有并控制业务生命周期，探针的 `dispose()` 只清理探针自己的观察状态。

`createFrameworkCommitProbe()` 的 React Profiler callback 把 `actualDuration` 记为 `renderMs`、`baseDuration` 记为 `baseRenderMs`，把 `commitTime` 仅当时间戳。React Profiler 没有在这里提供 commit 阶段耗时，绝不能把 `actualDuration` 或 `commitTime` 冒充 `commitMs`；只有宿主独立测得 commit duration 时才通过 `recordCommit({ commitMs })` 写入。公共生命周期 adapter 使用独立的 `recordUpdateWindow({ updateWindowMs })`，其 `framework-lifecycle` source 不能夹带 render/commit 字段。`@condev-monitor/vue/animation` 已把 Vue 的 `onBeforeUpdate` → `onUpdated` 接成显式组件范围更新窗口，但它仍不是 Vue render、commit、paint 或 GPU 时间。Angular 的公开 hook 只能证明 `ngDoCheck` → `ngAfterViewChecked` 组件检查窗口，因此使用独立 `recordCheckWindow({ checkWindowMs })` 和 `framework-check` source；它可能包含后代检查，不能证明 DOM mutation。Angular 20+ 的 application-wide `afterEveryRender({ read })` 只用于 DOM render 后的 target 同步，不与组件检查窗口拼接成耗时。Svelte 5 runes 没有组件级统一 before/after update；`@condev-monitor/svelte/animation` 只能从显式 `$effect.pre` 开始，并在公开 `tick()` 确认 pending state changes 已应用后闭合追踪依赖窗口，不能证明指定组件或 target 发生 DOM mutation。支持范围内的 Solid（`>=1.9.10 <2`）没有公开的组件级 before/after commit 或 after-paint hook，且 effect 顺序不能证明单一组件更新边界；`@condev-monitor/solid/animation` 因此只提供匿名 owner 和调用方显式 callback 的通用 host `script` self-time，不写入 framework update/check 字段。五种 adapter 都不等于已经获得全树 owner/why-update。

`createThreeRendererProbe()` 读取 public `renderer.info` 的 calls/primitives/geometries/textures/programs 和可选 context-lost 状态。GPU time 采用 fail-closed：只有已完成的有限异步结果同时满足 `valid:true`、`disjoint:false`、`contextLost:false`，且 source 与声明的 backend 匹配，才作为 measured 保存。`webgl`/`webgl2` 只接受 `webgl-disjoint-timer-query`，`webgpu` 只接受 `webgpu-timestamp-query`；中性的 `host-timer-query` 可用于 GPU-capable backend（包括 `unknown`），Canvas2D 不接受任何 GPU source。backend 为 `unknown` 时不会接受 WebGL/WebGPU 专用来源，跨 backend 的来源同样变为 `invalid`；直接调用 host sink 的错配样本会被拒绝。探针不创建真实 query、不调用 `gl.finish()`，也不把 `performance.now()` 包围 `render()` 的 CPU submission 冒充 GPU time；真实 adapter 必须在渲染循环外稀疏发起/轮询异步 query，让 `readGpuTiming` 只读取已经 resolve 的结果。

`@condev-monitor/react/animation/r3f` 默认仍只通过 R3F public `addAfterEffect()` 和 Three public frame sequence 读取真实已完成 renderer frame 的 counters，不启动第二个 rAF，也不调用 `render/invalidate/advance/setFrameloop`。显式传入 `gpuTiming: { disjointQueryOwnership: 'exclusive' }` 后，observer 才会在该 Canvas 内增加一个 root-scoped、最早优先级的 public `useFrame()` 开始边界，并通过共享的 public `addAfterEffect()` 完成或取消边界；其他 Canvas 的全局 tick 不会消耗这个 root 的 `sampleEvery` 采样槽。observer 通过 `renderer.getContext()` 取得已经创建的 WebGL context，稀疏发起异步 disjoint timer query。该所有权声明要求应用、renderer plugin 与其他 profiler 都不再读取 disjoint 状态或持有同类 query，同一 renderer 也只允许一个启用 GPU timing 的 Condev observer；无法证明时必须关闭。结果只覆盖 Condev root callback 之后到全局 after-render 之间向该 context 提交的 GPU work；更早的 global `addEffect()` 或同优先级且先执行的 callback 不在区间内。它不是 compositor presentation，也不能区分 mesh、React component、post-processing pass 或 Canvas 内部命中。demand/never root 只有真正进入 update 且 Three public frame sequence 前进时才会保留样本；否则取消 query。清理只取消/删除 Condev 自己的 query，不 dispose renderer/context。

`createRendererHostProbe()` 是 Canvas2D、原生 WebGL/WebGPU、R3F、Pixi、Babylon 等宿主的通用显式入口。宿主只把 public counter 映射到闭集的 `drawCalls/triangles/lines/points/geometries/textures/programs`，接口不接收引擎名、scene object、selector、URL、shader、texture identity 或任意 metadata。显式 `gpuTimerCapability` 把“已支持但结果尚未 resolve”与 `unsupported`、`disabled`、`unknown` 分开；旧调用缺字段时继续由既有 GPU status 保守推导。调用方明确提供的 counter 必须是有界非负整数；无效字段、能力与结果矛盾或 context 状态会让该次读取整体失败，不能静默伪装为“未观测”。抛错 getter、嵌套 GPU accessor 和 revoked Proxy 都被隔离，GPU 读取异常只能成为 `error`，不能成为 measured。Canvas2D 可以提供 counter，但浏览器没有通用 Canvas2D GPU timer，因此 `supported` 能力和任何 Canvas2D GPU duration 都被拒绝。探针只在调用方执行 `capture()` 时读一次，不启动 rAF、不 monkey-patch draw API、不调用 `gl.finish()`、不扫描私有字段。Browser 单入口也提供 `client.animation.createRendererProbe()` 并在销毁 client 时统一清理。

`createGsapLifecycleProbe()` 只使用 `globalTimeline.getChildren()` 和 `ScrollTrigger.getAll()` 公共 API，不读 private ticker，也不会在 `dispose()` 中调用 `kill()`。单次 total/active count 只是 inventory，不是泄漏结论。`createGsapLifecycleCycleAnalyzer()` 只接受显式、有序的 mount → 同一代表交互 → 应用自行 cleanup/unmount 序列；乱序会作废当前半循环，新 mount 才能重新同步。它默认最多保留 10 次 cleanup 快照，并要求至少三次由调用方声明为等价的循环。只有某类 post-unmount public inventory 在尾部窗口中逐次严格增长时才返回 `growth-candidate`；公开证据不完整是 `inconclusive`，`no-strict-growth-candidate` 也只表示这个严格谓词未触发，不能解释为中间或长期完全没有增长。它不保存 route/cycle 标识、不进入 host/RUM projection，也绝不输出 leak；仍须保证相同 route/build/输入/等待/cleanup，并结合 heap/post-GC plateau 才能讨论内存泄漏。

`createGsapTickerObserver()` 只通过 public `gsap.ticker.add(listener)` 订阅，并使用同一 listener identity 调用 `remove()`；它采用默认的 GSAP core 更新后顺序，不读取或修改 `fps()`、`lagSmoothing()`、`timeScale()` 等控制能力。其有界 `deltaTimeMs` 只是 GSAP ticker callback 间隔：GSAP 时间可能经过 lag smoothing，隐藏页面 callback 也会被浏览器节流，所以它不是页面实时 FPS、显示刷新率、presented-frame 或 GPU time。SDK 不设置通用慢 tick 阈值；只有宿主显式提供 `slowTickThresholdMs` 时才生成全流 `slowTickTotalObservedCount`。这份结果目前仅在本地 standalone observer 中存在，不进入五类 host sink、RUM 合同或平台；Browser 便捷方法只增加 client-owned teardown，不改变证据去向。若 `remove()` 抛错，observer 立即停止记录并把 `cleanupFailed` 保留下来；`client.destroy()` 尝试清理后仍失败时，调用方保留的 observer 可以再次 `dispose()` 重试，不能把未证明的清理伪装成成功。

`createScrollTriggerObserver()` 只读取 public `ScrollTrigger.getAll()`，以及每个实例的 `progress/direction/isActive/start/end/getVelocity()`。`getVelocity()` 按官方合同标为 `px/s`；`end - start` 只有在两个值均为有限数且顺序有效时才进入 span 分布。它为 `scrollStart/scrollEnd/refreshInit/refresh/revert/matchMedia` 六类公开 global event 注册成对 listener，并在事件发生时自动保存一条闭集聚合 checkpoint；调用方也可以显式 `capture()`。单次 checkpoint 最多读取 `maximumTriggersPerCapture` 个数组槽位（默认 512、上限 4,096），剩余数量进入 `uninspectedTriggerCount` 并设置 `triggerListTruncated`，不会把未检查实例算成 rejected 或完整覆盖；array 类型/长度/槽位读取、实例字段和统计返回值都经过异常隔离或冻结。这些只是 ScrollTrigger 全局生命周期边界，不是 route/mount/业务交互/unmount、动画完成、presented frame 或性能因果归因。observer 不调用 `refresh()`、`update()`、`kill()`、`enable()`、`disable()` 或 scroll setter，也不保存实例、DOM、selector、id、vars、callback 或 scroller；单字段异常只增加拒绝计数，不会吞掉同一实例的独立公开证据。结果仍是 local standalone，不进入五类 host sink、RUM 或平台；移除失败会保留 `cleanupFailed` 并允许重试。

`createLenisScrollObserver()` 只监听 public `lenis.on('scroll', listener)`；优先使用返回的 unsubscribe，并为兼容宿主回退到同一 `off('scroll', listener)`。它不调用 `raf()`、`scrollTo()`、`resize()`、`start()`、`stop()` 或 `destroy()`，不推进也不控制业务滚动。每个事件会立刻收缩为闭集 `isScrolling/progress/velocity/lastVelocity/direction/time` 证据；原始 event、target、selector、options、callback 和 user data 都不进入 ring。Lenis 宿主只在 observer 仍可订阅或重试清理时暂存，dispose 清理成功后释放。`progress` 限定为 `0..1`；velocity 只叫 signed numeric sample，因为 Lenis 公共合同没有稳定的 `px/s` 物理单位；没有读取 orientation 时，direction 只统计证据中性的 `negative/zero/positive`。`latestObservedLenisTimeMs` 只是最后一条 accepted scroll event 暴露的 public Lenis `time`，不是 event timestamp、事件年龄或 latency。计数描述完整 accepted stream，分位数只描述有界 retained tail。这份证据同样是 local standalone，不进入五类 host sink、RUM 或平台，清理不确定性通过 `cleanupFailed` 保留。

`createVideoFrameProbe()` 只调度/取消 `requestVideoFrameCallback` 观察，不调用 `play()`/`pause()`，也不改 `src/currentSrc`。第一条 RVFC callback 只建 baseline，不产生 delta；时钟、presented counter 或 playback-quality counter 回退后同样重建 baseline，避免把 seek/source reset 误报成负值或巨量掉帧。页面从 hidden/offscreen 恢复到 visible 时，宿主必须调用 `resetBaseline()`；它只重置测量基线，不控制视频播放，可避免把后台暂停期间误记成一条巨大的 callback/media delta。`getVideoPlaybackQuality().totalVideoFrames` 是浏览器的累计 playback-quality total，探针只使用相邻 callback 的 delta；它不是 decoded-frame count。RVFC metadata 的 `presentedFrames` 是另一条展示计数，不能与前者互换。

以上完整宿主样本、类别和本地明细都保持有界，不进入严格 `animation_rum` v1，也不会被整体上传。显式启用的 RUM v2 只会从它们重新构造目录允许的少量闭集聚合，例如 renderer GPU/draw-call/triangle p95，并继续携带 provider 数量、截断和拒绝状态；其余字段仍只在本地。GPU timer capability 会按闭集投影：`supported`、`unsupported`、`disabled`、`unknown` 不再互相混淆。`supported` 且尚无 resolve 结果是 `not-observed`；出现 `invalid`/`disjoint`（包括有效与拒绝结果混合）时 GPU p95 保守降为 `unknown`，不会伪称 measured。当前 v2 wire 没有 GPU 专属 partial limitation，因此不上传无法解释的 partial 子集。但既有页面结果指标和总体 `monitorOverhead` 会如实反映页面表现与探针真实成本，“本地”不等于“零开销”。这些证据在本地把 `renderer`、`resourcesMedia`、`memoryLifecycle` coverage 提升到的上限仍是 `partial`；`workAvoidance` 在没有明确 hidden/offscreen/avoided-work 协议前保持 `not-instrumented`。尚缺 heap/post-GC plateau、完整 route/resource cleanup、WebGPU 跨 command buffer/引擎私有 encoder 归因、decode → upload → first-visible、通用框架自动 owner/update 归因和 CDP pipeline trace。缺口必须继续显示为缺口，不能因 helper 已接入就标成“全覆盖”。

## 页面与目标不是二选一

页面级 collector 从 `start()` 到 `stop()` 始终存在。点击浮层准星只启动一次性选择器；选中后创建一个并行目标 sidecar，不过滤页面帧、不重启 observer、不更换页面 `captureId`。目标结果分三层：

| 关系                                | 可以说明什么                                                              | 不可以说明什么                                       |
| ----------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------- |
| `direct-element` / `direct-subtree` | 标准 CSS/WAAPI 动画、生命周期、关键帧属性候选、连接与尺寸确实属于目标范围 | 自定义 rAF 改 style 未被观测时，不能写成目标没有动画 |
| `temporal-overlap`                  | 选中窗口期间的 frame、LoAF、Long Task、Event Timing                       | 不能把重叠写成该元素造成卡顿                         |
| `framework-owner` / `renderer-host` | 显式 adapter 提供的组件 owner、commit 或 renderer 证据                    | 不能靠 DOM 猜框架私有对象、GPU 时间或场景对象        |

Picker 使用临时全页选择玻璃层、准星光标和轮廓；点击被工具拦截，Escape 取消，选中后重新打开 Target 工作区。选中后处于 ready，不会自动开始一个无限窗口：Start 开始有界目标窗口，Stop 完成并保留冻结的相关快照，Reset 取消仍在运行的旧窗口并开始新窗口，Clear 取消活动窗口、断开 sidecar 并清除选择。四个操作都不停止或重置页面 collector。

选择玻璃层存在时，宿主的全局 capture handler 应排除 composed path 中的 `[data-condev-animation-picker]`。工具本身不会暂停页面 collector。

## 采集窗口充分性与 Web Vitals 范围

`snapshot.captureSufficiency` 是本地证据门禁，不是综合健康分。只有下面四个条件同时成立才是 `sufficient`：

| 条件                  | 本地字段/原因                                         | 解释                                      |
| --------------------- | ----------------------------------------------------- | ----------------------------------------- |
| 可见测量至少 5,000 ms | `visibleDurationMs` / `visible-window-too-short`      | hidden 时间不能凑够可见窗口               |
| 至少 30 个保留帧      | `retainedFrameSamples` / `insufficient-frame-samples` | 看 retained，不用全窗流式总数替代尾部分布 |
| frame ring 没有截断   | `frameSamplesTruncated` / `frame-buffer-truncated`    | 截断后的 retained tail 不是完整窗口       |
| 刷新率置信度不是 low  | `refreshConfidence` / `refresh-confidence-low`        | 低置信度预算不能升级为充分证据            |

快照另外保留 `hiddenDurationMs` 和 `otherDurationMs`；后者是 prerender 与 unknown 的合计。存在帧证据但门禁不满足时 frame coverage 为 `partial`，完全没有帧证据时为 `not-observed`。`insufficient` 不能解释成“没有问题”。

Web Vitals 是另一种时间范围。`packages/browser-utils` 只启动一套共享 CLS/INP/LCP 观察，animation 使用 live + replay-latest 通道，所以 `snapshot.webVitals.scope` 固定为 `document-lifetime`，latest 值可能早于 collector 的 `start()`。它只保留 value/delta/rating/navigation type 以及闭集数字归因和少量枚举，不保留 DOM Node、selector、URL 或原始 PerformanceEntry。该值不能除以本次 visible duration，也不能写成某个 target 窗口造成。

这些 Web Vitals 只进入 animation 的本地快照，不进入 `animation_rum` v1。旧的通用 `Metrics` integration 继续使用共享运行时的 final 通道，并保持原有 `performance` event 的 name/value/path 语义；两条用途不能混成重复的 animation RUM 指标。

## Resource Timing 的窗口、隐私与完整性边界

`snapshot.resourceTiming.scope` 固定为 `capture-window`。只接收 `startTime >= collector.start()` 且在 capture 关闭前交付的资源；在采集开始前已经发起、但跨过窗口边界才结束的资源也会被排除，因为 transfer/encoded/decoded bytes 描述的是整个请求，无法像一段 duration 一样安全裁剪。晚于页面加载才启动的探针只能说明该窗口内观察到的资源，不能冒充完整首屏或整次 navigation 资源预算。

隐私清洗发生在共享运行时分发之前：`PerformanceResourceTiming.name`、完整 URL、query、hash 和 redirect location 都不会进入 animation collector 或本地快照。闭集摘要只保留 initiator 分类、duration，以及浏览器实际暴露的 `transferSize`、`encodedBodySize`、`decodedBodySize`。其中 `transferSize === 0` 必须原样保留，不能用 encoded bytes 回填；0 可能来自 cache、Service Worker、连接复用或跨源 timing 不可见，不足以单独判定命中缓存。

资源证据有两个不同的丢失边界，界面和建议必须分别显示：

| 边界                          | 本地证据                                          | 能说明什么                                                                                                                        | 不能怎样处理                                                                           |
| ----------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| SDK bounded ring              | `retainedCount`、`droppedSampleCount`、`capacity` | ring 满后旧明细被逐出；全窗 streaming count/duration/byte/category total 仍包含这些已接收条目，retained duration 分布只是有界尾部 | 不能把 retained tail 当完整全窗分布                                                    |
| 浏览器 Resource Timing buffer | `bufferEventCapability`、`bufferFullEventCount`   | `resourcetimingbufferfull` 表示浏览器可能在 SDK 接收前就丢了条目                                                                  | 调大 SDK `maxResourceEntries` 不能恢复浏览器已丢条目；事件 API 未支持/未知时不能显示 0 |

此外还有一个适用于各种 PerformanceEntry 的通用机制：浏览器按 entry type 的 buffered Performance Timeline tuple 分别维护 dropped count，并只在 `observe()` 后第一次非空 callback 的 options 中提供一次性 `droppedEntriesCount`。共享运行时每个物理 observer 只订阅一种 type，因此 SDK 保存在对应页面摘要中的 `performanceObserverDroppedEntryCount` 能说明该类型到首次 delivery 时已有 timeline history 未被 buffer 保留，但不能证明当前订阅漏掉了实时 delivery；它不是实时 callback 漏采计数，也不是上表任一 Resource Timing 专用边界。正数会保守地把对应页面聚合与 RUM 证据降为 `partial`，但不会反向污染观察器注册之后的 action/interaction 窗口；`null` 是未知而不是 0，属性缺失表示自定义或旧运行时没有实现该证据。精确原始计数只留在本地快照，不进入 `animation_rum` v1/v2。

即使 Resource Timing 自身没有 ring eviction 或 browser-buffer-full，`metricCoverage.resourcesMedia` 仍只能是 `partial`。它覆盖请求分类、大小和 duration，却没有 video `requestVideoFrameCallback` cadence、decode → GPU upload → first visible、dropped/total playback frames、autoplay/visibility 行为或 renderer upload 证据；必须等 media/renderer adapter 后才能讨论更完整 coverage。

这些字段当前只服务本地开发诊断，不进入严格 `animation_rum` v1 的 allowlist、DSN schema、Worker projection 或 ClickHouse keys。当前 SDK 上报入口仍是：

```text
http://localhost:8082/dsn-api/tracking/<appId>
```

本地 Resource Timing 不要求修改 `.env` 或上报 URL。若未来决定把它作为线上聚合上报，必须同步设计闭集 v2，并一起修改 SDK、DSN 校验、Worker、ClickHouse、Monitor API 和 frontend；通常仍可复用同一个 `/dsn-api/tracking/<appId>` transport endpoint，只对版本化 payload contract 做升级，不能先由 SDK 单方面把本地明细塞进 v1。

## 指标怎么定值

第一版把数值分成两类，界面和 API 都必须显示来源，不能混成一个“动画分数”：

- 标准阈值：Long Task 和 Long Animation Frame 的浏览器定义阈值为 50 ms；线上 INP 使用 p75，`<= 200 ms` 为良好、`> 500 ms` 为较差；
- 项目调查预算：慢帧定义为超过当前 frame budget 的 1.5 倍。slow-frame rate、连续 burst 长度、每次交互 missed-display 数和监控开销只是可配置的排查触发器，不冒充 Web 标准。

frame budget 优先取受控设备的显式刷新率；否则只从可见状态下最快且稳定的一组 rAF 样本保守推断，并输出 source、confidence 和 sample count。一个看起来只有 30 Hz 的流可能是 60 Hz 页面已经被节流，不能自动把它改判为健康的 30 Hz。平均 FPS 只做辅助展示，验收依据是 p50/p75/p95/p99/max、慢帧比例、missed-display 估算和连续 burst。

推荐规则必须把“症状 → 归因 → 最小改动 → 复测”连起来：

| 观察到的证据                          | 优先检查             | 给使用者的修改方向                                                                                                                                |
| ------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 慢帧与 Long Task 重叠                 | JS 主线程            | 将大任务切片或移出热交互，避免在逐帧回调中解析大数据、创建大量对象或同步执行无关工作                                                              |
| LoAF 的 style/layout 后续管线 tail 高 | 渲染管线             | 检查 style/layout 及其后的 render/paint/presentation；批量 DOM 读写，移出循环中的强制布局，并复查绘制面积与层数量。该 tail 不是纯 layout CPU 归因 |
| Event Timing input delay 高           | 事件前已有阻塞       | 缩短前序任务、延迟非关键 hydration/第三方代码、检查同一时刻的 Long Task                                                                           |
| processing duration 高                | handler 自身         | 缩小同步 handler，把连续 pointer/scroll 工作合并到一帧并避免重复计算                                                                              |
| presentation delay 高                 | handler 后到展示仍慢 | 对齐下一帧的 style/layout/paint/合成工作，结合 LoAF 而不是只改事件函数                                                                            |
| scroll/drag 局部尾部差、全页尚可      | 语义交互被平均值掩盖 | 只围绕该交互复测，减少逐样本状态更新、DOM 查询和框架重渲染                                                                                        |
| hidden 状态仍有帧或 renderer 工作     | 生命周期             | 在 visibility/pagehide/unmount 暂停 ticker、视频和 renderer，恢复时重新建立时间基线                                                               |
| 重复 mount/unmount 后 active 资源增长 | 清理                 | 对称移除 listener、observer、rAF/ticker、ScrollTrigger，并 dispose texture/material/geometry/render target                                        |
| reduced-motion 下仍持续非必要运动     | 可访问性             | 保留信息和控制，替换或停用 parallax、scrub、自动旋转、镜头移动和 autoplay                                                                         |

连续 pointer/drag/scroll/gesture 还需要宿主证明浏览器无法自动推断的动效质量。`InteractionHandle.recordQuality(sample)` 只读取以下闭集数值：`inputToVisualMs`、`pointerSampleAgeMs`、coalesced available/consumed、直接或 intended/visual 推导的 progress error、`domWebglAlignmentErrorPx`、`controlWritersPerFrame`、`settleTimeMs`、`overshootRatio` 和 `oscillationCount`。这些是显式 host evidence，不是 Event Timing 或 DOM 猜测。

每个 interaction 默认保留 256 个、最多 4,096 个 quality sample。duration 必须在 `0..600000 ms`，progress 在 `0..1`，overshoot 在 `0..100`，count 必须是有界非负整数；progress 与 coalesced 字段必须成对且内部一致。无有效字段、越界、非有限、pair 不完整或 consumed 大于 available 的样本返回 `false` 并计入 rejected；ring 满后旧样本计入 dropped。摘要分别暴露 accepted/retained/dropped/rejected、capacity、各字段分布、coalesced utilization 和多 controller conflict 次数。至少有一个 accepted sample 时，dropped 或 rejected 使该 quality window 为 `partial`；只有 rejected 而无 accepted 时仍是 `not-observed`，但 rejected count 保持显式。interaction 结束后的写入返回 `false`，不会改变已经冻结的摘要。

没有对应 capability、adapter 或观测窗口时必须显示 `unsupported`、`not-instrumented` 或 `not-observed`，不能显示成 `0` 或“正常”。所有建议的 `After` 初始值都是 `proposed`；至少用相同条件的三次、建议五次 Before/After 才能写成测量结果。

### 初始预算表

下面的 good/poor 除 Core Web Vitals 和浏览器 entry 定义外，都是 Codegrid 案例归纳后的项目调查预算，不是新的 Web 标准。第一版 SDK 只自动判断它实际采到且样本充分的行；其余行必须等对应 adapter 到位后才启用。

| 家族     | 指标                                     | 初始 good / 调查线                                     | poor / 强调查线                  | 当前状态                                                                   |
| -------- | ---------------------------------------- | ------------------------------------------------------ | -------------------------------- | -------------------------------------------------------------------------- |
| 用户结果 | LCP / INP / CLS                          | `≤2500 ms` / `≤200 ms` / `≤0.10`                       | `>4000 ms` / `>500 ms` / `>0.25` | 已接共享 document-lifetime 脱敏 latest；线上验收仍按 field p75             |
| 帧节奏   | target frame                             | `1000 / refreshHz`；60 Hz=`16.67 ms`，120 Hz=`8.33 ms` | 不设固定 poor                    | 已实现；优先显式刷新率，否则保守推断并带置信度                             |
| 帧节奏   | frame p95                                | `≤1.5 × frame budget`                                  | `>2.5 × budget`                  | 已实现本地判断                                                             |
| 帧节奏   | slow-frame rate                          | `<5%`，slow 指 `>1.5 × budget`                         | `>15%`                           | 已采集；跨 capture 以 p75 查看                                             |
| 主线程   | LoAF                                     | entry 定义为 `>50 ms`；调查预算 `<3/min`               | `>10/min`                        | 已采 count/p95；Dashboard 按有效 window 显式换算 `/min`                    |
| 主线程   | Long Task 总时间                         | `<300 ms/min`                                          | `>1000 ms/min`                   | 已采 count/sum/p95/max；Dashboard 按有效 window 显式换算 `/min`            |
| 交互     | input / processing / presentation p95    | `≤100 ms`                                              | `>300 ms`                        | 已实现支持范围内的三阶段；最终 field gate 仍看 INP p75                     |
| 渲染管线 | LoAF style/layout-start → frame-end tail | `<200 ms/min`                                          | `>800 ms/min`                    | 已采 tail p95 候选；不是纯 layout CPU 时间，累计预算和 source 定位后续补全 |
| 渲染管线 | LoAF render→paint / paint→presentation   | 不设通用阈值                                           | 不自动判失败                     | 已实现本地有界证据与能力状态；只覆盖 LoAF，presentation 可缺失且实现相关   |
| 监控自身 | callback self-time / capture             | `<1%`                                                  | `>3%`                            | 已采监控自身开销；必须另做无探针对照                                       |
| 动效质量 | 有限 UI 动效 `>300 ms`                   | 人工复核意图、可中断性和配对                           | 不自动判失败                     | motion adapter 后启用；100–150/150–250/200–300 ms 仅是起点                 |

后续 adapter 使用以下初始预算，但单个 draw call、DPR、heap 数值或动画时长不能独立判失败：

| Adapter 家族       | 指标                           | 初始预算                                                                                   |
| ------------------ | ------------------------------ | ------------------------------------------------------------------------------------------ |
| Three/WebGL/WebGPU | CPU 或有效 GPU p95             | `<0.8 × frame budget`；poor `>1.2 ×`                                                       |
| Three/WebGL/WebGPU | draw calls p95                 | `<1000`；poor `>3000`，且必须同时有 cadence/GPU 压力                                       |
| Renderer           | render-target pixels           | `<4 × viewport backing pixels`；poor `>10 ×`                                               |
| Canvas/GPU         | 连续 readback p95              | `0`；确有功能需求时另设区域和频率预算                                                      |
| Video              | dropped-frame rate             | `<1%`；poor `>5%`，按展示尺寸和代表设备校准                                                |
| Scroll/drag        | progress / alignment / latency | `≤1%` / `≤1 px` / `≤1 target frame`；poor `>5%` / `>4 px`；已提供显式 `recordQuality` 合同 |
| Lifecycle          | 等价 mount→interact→unmount    | 至少 3 轮，动画建议 5 轮后资源回到平台                                                     |
| Memory             | soak / post-GC growth          | 至少 10 分钟；`>10 MiB/min` 只触发调查                                                     |
| Work avoidance     | hidden/offscreen 非必要工作    | `0` active samples                                                                         |
| Accessibility      | reduced-motion violations      | `0`，但内容、焦点、控件和状态反馈必须保留                                                  |

### 目标与 Canvas/WebGL 应采什么

目标本地层当前已经采集：`getAnimations({subtree:true})` capability，running/paused/finished/pending，CSS Animation/CSS Transition/WAAPI 数量，duration/delay/playback-rate 分布，无限循环，animation/transition start/end/cancel，关键帧属性的 compositor/layout/paint/unknown 候选，连接状态，CSS 尺寸、viewport 相交比例和 resize 次数。Canvas 还会采 CSS/backing 宽高、backing pixels、`cssResizeCount`、`backingResizeCount`、`backingScaleX`、`backingScaleY` 和 `backingAspectRatioMismatch`。兼容字段 `effectivePixelRatio` 是两轴 scale 的几何平均值，非等比 backing 必须看分轴字段；检查过程绝不调用 `getContext()` 猜上下文。ResizeObserver 的首次强制 delivery 只建立 baseline，不计 resize；后续 snapshot 也会比较 backing attribute，避免漏掉未触发 ResizeObserver 的 backing 变化。

Canvas 内部和 GPU 必须由按 canvas 对象身份匹配的 adapter 提供，建议采集：

SDK 已提供 `createAnimationTargetAdapterRegistry(id, version)`：内部用 `WeakMap<Element, provider>` 做 capture-local 对象身份匹配，重复注册使用 generation 防止旧 unregister 删除新 renderer，注销幂等；它不从 selector/id/class/场景名生成键，也不会替 renderer 做阻塞式 GPU 采样。

SDK 驱动的每次 adapter 检查现在都会传入可选第二参数 `AnimationTargetAdapterInspectionContext`。只要 context 存在，`inspectionPurpose` 就是必需的闭集值 `'local' | 'rum'`，`evidenceWindow` 则只含同一 collector 时钟域的 `startedAt`、`endedAt` 和 `selection-window`/`interaction-window`。开发 Overlay、Browser 公开 `client.animation.selectElement()` 和 core 默认选择路径传 `'local'`，采样命中的 RUM v2 target sidecar 传 `'rum'`。registry provider 与 Browser `client.animation.registerTarget()` 回调都会收到同一 context；第二参数本身保持可选，因此旧的一参 adapter/零参 provider 仍源兼容，也可能完全忽略 purpose。purpose 是交给各 adapter 执行自身策略的用途信号，不是统一排除全部 RUM adapter 的总开关。新 renderer recorder 还必须用 window 筛选已有样本并返回实际保留样本首尾，不能因 Overlay 重复 snapshot 而清空或重置数据。

purpose-aware WebGPU transfer recorder 的最低兼容基线是首个协调版本：`@condev-monitor/monitor-sdk-animation` 能提供 `inspectionPurpose`，`@condev-monitor/monitor-sdk-browser` 能给 RUM sidecar 标记 `'rum'`，`@condev-monitor/monitor-sdk-animation-renderer` 再执行 exact-local 检查。使用高层 Browser entry 时应把三个包升级到同一协调发布；新版 renderer 若混用旧 animation core，旧 core 无法表达用途，transfer inspector 会安全返回 `null`。这个 fallback 不能被解释成其它 adapter 也已排除 RUM。

Target snapshot 的每个 renderer 输出都带归一化 `evidence`：window 的 start/end/duration，accepted/retained/dropped/rejected sample count，是否 truncated，以及 GPU validity。原始 `evidence` 在类型上为兼容旧 adapter 和 `observed:false` 保持可选；一旦声明已观测、保留了样本或提供任何非空指标，必须同时提供 window 两个端点。已提供的样本数量必须满足 retained + dropped = accepted；未知或不一致的数值会保留为 `null`，而不是制造 0。

Renderer window 必须与目标 collector 使用同一个 `AnimationRuntime.now()` 时钟域；普通页面通常就是该 document 的 `performance.now()`。不能混入 `Date.now()` epoch、`performance.timeOrigin + performance.now()`、Three Clock 秒数、原始 GPU ticks，或另一 iframe/worker time origin；只有 SDK 本身因缺少 Performance clock 而回退时，adapter 才使用相同回退基准。选择期 context 的安全结束点在 adapter 循环前采样，最终 `capturedAt` 仍在所有 adapter 完成后记录，因此 context-aware adapter 获得的是保守且必然被最终 capture 包含的上界；旧 adapter 在同步 inspect 内读取同一时钟的既有语义保持不变。完成交互后 context 直接使用 SDK 固定的精确 interaction window。

没有完成交互时，renderer window 必须完整包含于 `[selectedAt,capturedAt]`；完成手动目标交互后，必须完整包含于 SDK 自己记录的 `[correlatedWindow.startedAt,correlatedWindow.endedAt]`。仅 overlap 不够，因为已经聚合的 p95 无法裁掉窗外样本。缺端点、反向、选择前、未来、异域尺度、越过交互边界或 duration 不一致都会整体清空 renderer 指标，并产生本地 `renderer-evidence-window-invalid`。RUM v2 会独立复验 selection/correlation 算术、完整包含和 duration；被篡改数据或缺少 `correlatedWindow` 的旧 correlated snapshot 只会变成 `unknown`/`not-observed`，不会注册 renderer provider，也不会继续上报 measured。

- Canvas2D：可选 `packages/animation-renderer` 已实现宿主显式完整逻辑帧 CPU、闭集 path/text/image/pixel-write/clear/other command、同步 `getImageData`/`putImageData` 包裹时间与像素/bytes、边界可见 backing resize、context loss/restore；不完整 draw coverage 不会生成 drawCalls，离屏 canvas 总量、Worker 时钟 bridge 和 Canvas 内部对象仍需专项 adapter；
- WebGL/Three/Pixi/Babylon：CPU submission、有效且非 disjoint 的 GPU timer、draw call、triangle/point/line、program/pipeline、geometry/material/texture/render target、render-target pixels、buffer/texture upload、readback、shader compile、context loss/restore 和 dispose；其中 Babylon 已有只读 `SceneInstrumentation.drawCallsCounter` + `onAfterRenderObservable` 的页面级薄适配，其他字段仍不能由它推断；
- WebGPU：render/compute pass、dispatch/workgroup/storage texture、buffer/texture bytes、有效 timestamp query、device lost、异步 readback；
- media texture：RVFC cadence、presented/dropped、decode→upload→first-visible、hidden/offscreen pause；不读取或上报 `src/currentSrc`。

WebGPU 资源侧已新增显式 `createWebGpuTransferRecorder()`：宿主包裹 queue write/external-image copy，并以未经验证的 `submissionAttestation` 声明关联 copy command stream 已 submit 后，再包裹新建的 `mapAsync(READ)`。upload 只有在闭集原生同步调用精确返回 `undefined` 时才采信；非 void、Promise、跨 realm Promise 或自定义 thenable 仍原样返回，但证据会被拒绝且不会读取任意对象的 `then`。bytes 也是调用方声明；readback 时间是从紧邻 callback/`mapAsync` 调用前的时间戳到 recorder Promise reaction 执行的主机可观察上界，会包含 callback、queue、主线程与 microtask 等待，不能叫精确 GPU copy 或浏览器内部 fulfillment 时间。recorder 不会读取 mapped range、buffer/texture label、descriptor、像素或 shader。`AbortError` 只算 rejected readback，不能由此推断 device lost；只有 `device.lost` 是权威证据。现有本地 Target 已预留 `uploadBytes`/`readbackMsP95`，但 v1/v2 wire 目录尚未包含这两个值。它的 bound `inspect()` 只接受 `inspectionPurpose` 精确等于 `'local'` 的 SDK context；遇到 `'rum'`、context 缺失、purpose 缺失或不可读、重入、purpose 校验期间证据被修改等状态时直接返回 `null`，不会制造一个 unobserved provider。一个 Canvas 当前仍只能有一个 Browser target-registry provider，且 renderer evidence 只有一套 sample count；因此 pending 或任一 family correlation 缺口会令整个本地 Target provider 变为 unobserved。这个 recorder 仍应作为该 Canvas 唯一的 Browser registry provider；同一 Canvas 现在可以注册 `registerRumTarget()`，因为 transfer provider 会在 RUM sidecar 中退出，而 native target 证据及其它 adapter 仍按各自合同处理。后续合并 timestamp-frame 与 transfer-operation 证据仍需 per-family evidence/composite contract。本次只是 SDK/adapter 路由收紧，不改变 v1/v2 metric 目录、wire contract、DSN/Worker、后端数据库 schema、Monitor API 或平台展示合同。

`performance.now()` 包围 Canvas 逻辑帧、`render()` 或 `queue.submit()` 只能叫 CPU 时间/submission，不能冒充 GPU time。`gpuFrameMsP95` 采用 fail-closed：只有 adapter 同时声明完整 validity，且 source 与 renderer family 匹配时才保留。Canvas2D 没有 renderer-independent GPU timer，专用 recorder 永不生成 GPU duration。`webgl`/`webgl2` 对应 timer query，`webgpu` 对应 timestamp query；中性的 host summary 只接受合法 renderer family。未报告、无效、validity unknown、disjoint、context lost、source unknown、host 专用来源混入 target，或 backend/source 错配，都输出 `gpuFrameMsP95:null` 和闭集 `rejectionReason`；错配原因为 `backend-source-mismatch`。RUM v2 投影会再次执行同一闭集兼容校验，运行时被篡改或旧快照也不能把错配值上报。可选 `packages/animation-renderer` 已实现 Canvas2D 有界数字 recorder 和 WebGL 1/2 的稀疏异步 query；Canvas recorder 不调用/代理 context、不 patch prototype/getContext、不调度 rAF/timer、不保存像素，只有宿主完整声明并记录的 command 才能映射为 drawCalls。WebGL 必须由宿主同步包围完整 renderer frame、显式声明独占 disjoint/timer-query 状态，并在 context restoration 后重建；它的 bound `inspect` 可直接按 canvas 对象身份注册为 Target provider，独立保留有界 query-frame 历史，只聚合完整包含于 SDK selection/interaction window 且已经异步 resolve 的结果。Target 使用 `webgl-timer-query`，页面 host 继续使用 `webgl-disjoint-timer-query`；pending、截断、无效、disjoint、context lost 和 error 都保持显式且 fail-closed，重复 Overlay snapshot 不会重复新增样本。这个归因边界仍是整个 canvas，不是 Three/Pixi/Babylon 的内部对象。Babylon 薄适配器只订阅公共 `scene.onAfterRenderObservable`，读取调用方先创建的公共 `SceneInstrumentation.drawCallsCounter.current/count`；它通过调用方提供的公共 `PerfCounter.Enabled` 实时读取器在每次快照前后校验启用状态，禁用、抛错或读取中变化时不发布样本也不推进 counter count 去重序列，并且同一 monitor/scene 最多只允许一个适配器。它不调用 `scene.render()`、不读私有 `_drawCalls`、不启用 GPU instrumentation。Babylon WebGL/WebGPU 的这个值只是引擎 draw/command accounting，不能当等价硬件工作；triangle、资源、GPU、Target 和 presentation 均保持未观测。同一包也已实现 WebGPU 单 pass 与同一 command buffer 多 pass timestamp query：device 必须在创建时启用 `timestamp-query`；单 pass 宿主声明该 pass 就是完整 renderer frame，多 pass 宿主则把首/末 descriptor 同一事务交给对应 pass，并在所有 pass 已结束后作精确 attestation。两者都只在关联 command stream 成功 submit 后启动异步 map，不调用 `finish()` 或 `queue.submit()`。多 pass 结果是首 pass begin → 末 pass end 的 GPU 区间，包含中间 pass/copy，但不能拆分成逐 pass 耗时；它仍不覆盖跨 command buffer/submit、边界外命令、CPU submit、浏览器 composition/presentation/scanout。全零未写 readback 为 `invalid`，非零相等时间戳才可保留量化 `0 ms`，device lost 后必须重建设备和 timer。所有 renderer 工具仍不 patch context/renderer，不调度 rAF/timer，也不调用 `gl.finish()`/`gl.flush()`。Three mesh、Pixi display object、Babylon mesh 等内部对象需要 renderer 的 raycast/hit-test adapter，跨源 iframe 和 OffscreenCanvas Worker 需要各自 bridge。

## 代码归属

### `packages/animation`

动画监控的唯一浏览器真值层：

- 可见状态下的 rAF 帧间隔、分位数、慢帧比例、missed-display 估算和连续卡顿 burst；
- 支持时的 Long Animation Frame、Long Task、Event Timing；
- capture-window Resource Timing 的脱敏分类、duration 和 size 聚合，以及独立的 SDK ring/browser buffer 完整性证据；
- 语义交互窗口，例如 scroll、drag、pointer、transition，以及显式 `recordQuality` 的有界质量摘要；
- 可见/隐藏/其它 duration 与 `captureSufficiency`；
- 共享 document-lifetime CLS/INP/LCP 的脱敏本地快照；
- capability、coverage、reduced-motion 和监控自身开销；
- 有界、脱敏的 production RUM projection；
- 开发环境 Shadow DOM overlay；
- 一次性 DOM Picker 与并行目标 sidecar；
- Target Start/Stop/Reset/Clear，Canvas 分轴几何/resize，以及 renderer evidence/GPU fail-closed；
- framework/renderer/lifecycle/work/media 五类闭集本地 sink，以及 React Profiler/manual commit、Three public counters、GSAP/ScrollTrigger public inventory、Video RVFC/playback-quality helper；
- React/Vue/GSAP/Three/Canvas/media 等可选 adapter 的多轴公共契约。

这个包不得依赖 React、Vue、GSAP 或 Three，也不得默认上传数据。

### `packages/browser-utils`

页面级共享浏览器运行时：

- 一个引用计数的 FrameClock；
- 每种 PerformanceEntry 类型一个共享 PerformanceObserver；
- 每个共享 PerformanceObserver 只读取第一次非空 delivery 的 `droppedEntriesCount`，并按逻辑订阅者分别保存“有资格接收初始 buffered history”的归属；后加入者是 live-only，不能继承旧订阅者的历史丢失证据；
- Resource Timing 在分发前移除 name/URL，并共享 `resourcetimingbufferfull` 生命周期监听；
- snapshot/stop/hidden/pagehide 和最后一个订阅者退出前，通过同一脱敏分发路径同步 `takeRecords()`，不漏掉仍在 observer queue 的尾部 entry；
- visibility、pagehide/pageshow 和 BFCache 生命周期；
- 一个进程/文档级的 CLS/INP/LCP multiplexer，向 animation 提供 live + replay-latest，向旧 Metrics 提供 final delivery；
- Web Vitals DTO 只保留 value/delta/rating/navigation type 与闭集数值归因，不传播 DOM、selector、URL 或 raw entry；
- feature detection 与最后一个订阅者退出后的清理。

它已经解决 animation 与旧 RuntimePerformance 重复创建 observer/rAF 的问题，也让 animation 与旧 Metrics 共用同一套 CLS/INP/LCP observer。旧 Metrics 的 final cadence 和 `performance` event name/value/path 保持兼容；animation 的本地 live snapshot 不额外生成 `animation_rum` v1 指标。

`droppedEntriesCount` 必须按 Performance Timeline 的一次性、按 entry type buffered-history 证据解释。正数只证明对应 type 的 timeline tuple 没有保留全部历史，不能把它写成 live observer delivery 漏采，也不能把后续实时 action/interaction 误标成漏采；0 是已知零，`null` 是 unavailable/invalid，不能互相替代。`takeRecords()` 本身没有 callback options，因此它若先取走首批条目，不能自行解析计数：已有资格的订阅保持未知，直到后续第一次 callback 给出一次性 options（若始终没有 callback 就继续未知）；之后新增的逻辑订阅是 live-only，不得重新声称 `buffered: true` 或继承旧历史证据。热更新迁移也必须终止旧 callback 的滚动语义，避免旧 closure 恢复已经废弃的计数方式。

### `packages/core` 与 `packages/browser`

- `packages/core` 定义 integration 生命周期和 transport 契约；
- `packages/browser` 创建稳定 client handle，协调 integration finalize、transport flush 和 destroy；
- animation 通过显式 integration 接入，不进入 browser SDK 的默认 bundle；
- lifecycle flush 在线时发送，离线时先等待持久化；持久化失败则恢复内存队列，不静默丢弃；
- RUM v2 的多报告请求收到 `400/403/409/413` 时只视为“批次终止”，不能把同批每项直接判死。`400/409/413` 有界二分，`403` 直接逐项确认；只有单项仍返回终止状态才写 terminal，合法 sibling 依靠精确 `2xx` receipt 独立确认，无效 receipt、网络错误、`429/5xx` 只重试受影响子集；
- 每个额外隔离请求前原子续租全部 unresolved 报告，失去任一租约就停止；进入 BFCache、suspend 或 destroy 后不再启动新子请求，未决项按原重试合同释放。page settlement 仍先解锁或终止 target，不能绕过 parent-before-child；
- 旧 `performance` 事件保持兼容，但逐步迁移到共享运行时，避免重复采集和重复上报。

离线 flush 的 Promise 现在会等待 IndexedDB 写入，失败时恢复内存队列；但浏览器可在 page termination 的任意时刻终止异步事务，最终 durable 仍必须用真实 Chrome/Firefox/Safari 的 pagehide/offline 场景门禁验证，不能只凭 Node 单测承诺“绝不丢失”。

### 后端

| 目录                        | 职责                                                                                                                                                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/backend/dsn-server`   | 公开但受限的 animation RUM 写入口；严格校验 schema、大小、隐私、appId、采样元数据和 v1 精确 metric tuple；不提供公开读 API                                                                                        |
| `apps/backend/event-worker` | Kafka 二次校验、幂等投影和专用 ClickHouse 表；无效 SDK envelope 的 DLQ 不保存原文；聚合当前在 Monitor 查询时完成                                                                                                  |
| `apps/backend/monitor`      | JWT + application ownership 下的 Animation 查询与 Labs 控制面；RUM v2 以 `FINAL` 子行计数和 event/scope 身份核对 completion marker；Labs 使用 2 小时 runner grant、流式 artifact、严格 schema/大小和 7 天访问期限 |
| `apps/backend/lab-runner`   | 用户/CI 本机的浏览器中立场景执行器；三引擎跑通用探针/动作，Chromium 另有 CDP/Lighthouse，只上传有界脱敏 report/trace-index                                                                                        |
| `.devcontainer/clickhouse`  | production animation capture、metric、diagnostic 表及 TTL                                                                                                                                                         |
| `.devcontainer/postgres`    | Labs run、一次性 grant hash 和 artifact 元数据                                                                                                                                                                    |

生产读接口必须位于有租户鉴权的 Monitor API；不能继续把只凭 `appId` 的查询放在 DSN controller。

### Dashboard

`apps/frontend/monitor` 中开发：

- `/animations`：已实现跨 capture 指标聚合和最近采集；SDK 证据完整性与 ClickHouse 存储投影完整性分开显示，子行不一致的 marker 从统计与趋势中排除；`count`/`sum` 不直接横比 raw total，而以 `windowDurationMs` 换算每分钟后再聚合；后续增加 route、release、device 的可视化筛选；
- `/animations/v2/[captureId]`：已实现匿名 context、frame/main-thread 指标、capability 和 12-family coverage；详情只展示通过 marker expected count、`FINAL` observed count、event/scope identity 和闭集 mapper 四层核对的子行，不完整投影返回 409；本地 raw timeline 不进入 RUM；
- 后续增加 recommendations、source candidate、Replay/trace 关联；
- `measured / partial / not-observed / not-instrumented / unsupported` coverage 显示。

每分钟归一化是 Monitor 查询层的显式派生值：仅接受至少 5 秒、没有触发 7 天 window cap、且 numerator 状态为 `measured` 的 capture，API 单独返回 `normalization.kind = per-minute`、`requiresMeasuredStatus = true` 和 `valuePerMinute*` 字段，前端明确标 `/min`。短窗、零时长、capped window 和 ring 截断产生的 `partial` numerator 显示为不可比较，不用被放大的 rate、capped denominator 或不完整 tail 猜值。LoAF/LongTask/interaction 的全窗 streaming totals 即使 percentile ring 截断仍可保持 `measured`；frame ring 派生的 burst/missed totals 则保持 `partial` 并被排除。summary API 对 count/sum 的 raw `value*` 聚合明确返回 `null`；raw count/sum 只在单次 capture 详情与 measurement window 一起查看。interaction throughput 等也不自动等价为健康/严重度。

Recharts 只用于聚合趋势。高密度时间线应使用分窗/降采样后的 Canvas 或 windowed SVG，并提供可键盘访问的选中事件详情。

### Labs 实验室

平台把 `/animations` 和 `/labs` 设为两个并列菜单是合适的，因为两者回答不同问题：

- `/animations` 是生产真实用户分布，长期、采样、匿名、低开销；
- `/labs` 是开发机或 CI 的可复现实验，允许 Chromium/Firefox/WebKit 重复动作；CDP trace 和 Lighthouse 仅是 Chromium 诊断能力；
- 同一问题应先由 RUM 找到高影响 route/device，再在 Labs 用固定版本、视口、缓存、节流和动作复现；两者不能混成一个分数。

Labs 的创建接口只返回一次原始 runner grant，后端只保存其 SHA-256。前端仅在当前成功弹窗的 React 内存中展示 token，不写 URL、localStorage、sessionStorage 或日志；关闭后无法再次读取，过期或丢失时应新建 run。Runner claim 后采用平台 run 的目标地址，但动作与 selector 仍只来自本地 scenario 文件。Monitor 后端自己不请求目标 URL。

Labs 面向的是 HTTP(S) 页面，不绑定被测项目的构建工具。npm、yarn、pnpm、Bun、Deno 或其他工具只需要把项目启动成一个 URL；Runner 自身要求 Node 22，Chromium 模式使用本机 Chrome/Chromium，Firefox/WebKit 模式使用显式安装的匹配 Playwright browser binary，测量时不会偷偷联网下载。localhost、局域网开发站和线上站都能作为目标，线上 runner 控制面强制 HTTPS 且拒绝重定向转发 grant。需要登录的当前 Playwright driver 可使用只留在 runner 本机的 `storageState`；这种情况下 Lighthouse 整轮明确跳过，因为它使用另一套导航，不能冒充已经复用了登录态。Playwright WebKit 只代表 WebKit 引擎覆盖，不等于真机 Safari/iOS 证据。

自动发现与执行已经拆成两个边界：

- `packages/animation-lab-explorer` 当前通过 Chromium 只生成有界、`needs-review` 的本地候选，它不是 Firefox/WebKit 兼容结论；当前自动发现 click、hover、scroll，以及 Canvas/较大或 authored-motion SVG 的 pointer-path，普通小 SVG 图标不作为 renderer 候选。DOM 收集和规划都按动作种类公平抽样，拒绝或隔离 submit、删除、支付、退出、文件、密码和跨源动作。这里的“只读”仅指不会主动派发这些交互；页面加载代码/网络仍会运行，并会在本地写 proposal JSON。selector、文字提示和坐标只在本地 proposal，上传 manifest 会重新按 allowlist 构造；
- Chrome Recorder JSON 走独立的有界 importer，保留安全步骤的原始顺序，但同样只生成 `local-only` 与重新 allowlist 构造的 `upload-safe`、`needs-review` proposal。它不会生成或执行 scenario。绝对 scroll、导航副作用、frame、double-click、change/value、wait expression、custom step 等无法安全无损映射的步骤会隔离或拒绝；输入值、表达式和 custom parameters 连派生本地 proposal 也不复制；
- `apps/backend/lab-runner` 通过 browser-neutral driver 执行审核后的 scenario。显式场景支持 wait、click、hover、pointer-path、scroll、resize、drag 和有限键盘动作，并为每个动作建立 runner 单调时钟窗口。Scenario selector 固定为标准 CSS，不接受 Playwright 私有 selector 方言。

Explorer 只能声明“发现到的有界候选样本”，不能承诺触发页面全部动画。程序化事件、业务状态、登录后分支、跨源 iframe、Canvas 内部命中、WebGL 场景对象和框架私有状态都需要开发者补充场景或显式 adapter；默认逐个点击所有控件既不安全，也不能证明覆盖完整。

这里的限制不是“暂时没写一个 selector”这么简单：

- 跨源 iframe 受浏览器同源边界隔离，父页面 driver 不能读取其 DOM；应由 iframe 所属源单独运行场景，或由明确授权的同源测试构建配合；
- Canvas/WebGL/WebGPU 对浏览器只有一个 surface，场景内按钮、mesh、粒子和命中区域不是 DOM 节点；需要业务/renderer adapter 暴露匿名语义 target 与受控动作；
- 登录后的隐藏业务状态依赖账号、数据、权限和导航历史，通用 crawler 不能证明枚举完整；应提供本地 auth state 与人工维护的场景前置条件；
- Vue/Angular/Svelte 的深层组件 owner/update 原因不是标准 Web API；没有公开框架 adapter 时仍可测最终帧、Long Task、Event Timing 与 surface，但 owner 必须是 `not-instrumented`；
- 真实 GPU time/WebGPU 深度指标需要 renderer 管理的异步 timer query、设备状态和 disjoint/context-loss 校验；Long Task 或主线程 trace 不能替它作证。

### 自动化 Driver 选择

Scenario DSL、报告和预算合同不依赖 Playwright。当前默认实现通过 `LabAutomationPage` 语义原语封装 Playwright 的 Chromium/Firefox/WebKit driver，后续可增加 WebDriver BiDi/Selenium adapter，而不用迁移场景 JSON。工具选择遵循下面的能力矩阵：

| Driver/collector                | 适合场景                                                 | 不能冒充的能力                                              |
| ------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------- |
| Playwright Chromium             | 默认重复实验、动作重放、页面探针、CDP trace、Lighthouse  | 真机 Safari/iOS、renderer 内部 owner、真实 GPU timer        |
| Playwright Firefox/WebKit       | 同一场景跨引擎的页面结果与动作窗口对比                   | CDP trace、Lighthouse、CPU/带宽节流、等价 Chrome cache 清理 |
| 后续 WebDriver BiDi/Selenium    | 企业 Grid、既有 WebDriver 基础设施、品牌浏览器/远端设备  | Playwright storage state 无损复用、Chromium 专属 trace      |
| Chrome Recorder importer        | 把人工录制的安全动作带入审核队列                         | 自动审批、全动画覆盖、绝对 scroll 到 wheel delta 的等价转换 |
| 显式 framework/renderer adapter | 组件 owner、业务 outcome、Canvas scene target、GPU timer | 无 adapter 时猜测私有框架/renderer 状态                     |

Firefox/WebKit 请求 trace 或 Lighthouse 时，会保留 0-duration 的显式 unavailable attempt、空 metrics 和安全 limitation；不会把未知值写成 0。CPU throttle 或 latency/throughput 等受控条件无法复现时在导航前 fail closed；cold cache 只能通过新 context 隔离时明确记录 limitation。Playwright 的自动化 tracing 也不能冒充 Performance/CDP trace。

上传语义把每个被测动作拆成 `actionId + trigger + subject + outcome + timestamps`，并把 renderer/framework/motion/browser 证据作为可多值技术轴，而不是猜一个“框架名称”。指标使用闭集 `metricId + scope + aggregation + budgetRefs + evidenceRefs + limitations`。平台详情页按左侧动作、右侧证据展示触发方式、主题/表面、时间窗、技术证据、指标、阈值、发现与建议；页面右下角浮层则消费 SDK 的本地 Target/host adapter 证据。没有框架 adapter 的原生页面仍可测帧、主线程、交互和 DOM/SVG/Canvas 表面，但 owner、真实 GPU 时间等必须显示 `unsupported`/`not-instrumented`，不能填 0。

默认诊断合同固定为 60 Hz（16.666667 ms），不是根据已经变慢的页面自校准。兼容指标 `frame.refresh.inferred` 的准确含义是“可见页面 rAF 帧间隔 p50 推算出的回调节奏”，不是物理屏幕刷新率、compositor presentation FPS 或 GPU FPS；平台会显示这一限制，不能用它自动放宽预算。省略 `measurementContract` 时继续使用 `condev.animation.default@1`：frame p95 `<=1.5×frame budget`（至少 120 帧）、slow-frame rate `<=5%`（至少 120 帧）、jank burst `<=0`（至少 120 帧）、Long Task count `<=0`（至少 1 个已观察任务）和 input delay p95 `<=100 ms`（至少 3 个事件）。

示例场景显式选择 `condev.animation.default@2`。@2 只改变 Long Task 的零事件证据语义：完整的 run-level `measured` 观察且 `value: 0 / samples: 0` 可以证明该观察窗口没有 Long Task；正值和正样本仍产生 finding。`partial`、`unsupported`、`unknown`、`not-observed`、缺失、样本溢出以及 `value`/`samples` 的零值状态不一致都保持证据不足，不能伪造一个样本。@1 与 @2 的规则身份进入 protocol hash，跨版本比较属于预算合同漂移，不能直接评价改善或退化。平台后端会为历史兼容原样保留一致的未知预算引用，但前端不会猜测其阈值；本地 Runner 只执行已知版本。这些是版本化项目预算，不是浏览器标准或跨业务统一评分；高刷场景应在 scenario 明确写入 refresh contract。

Event Timing 使用 `durationThreshold: 16` 观测，所以事件总时长、input delay、processing 和 presentation delay 的 p95（包括动作窗口）都是“浏览器在该阈值下暴露的条件样本分布”，不是全部输入事件的分位数。`interaction.count` 统计保留的 `PerformanceEventTiming` 条目，也没有按 `interactionId` 去重，不能解释成独立交互次数。Runner 会把这两项限制作为闭集代码保留到跨次聚合和 input-delay finding；数值仍可标为已测量，但 UI 必须同时展示样本边界。

Lab 的 `media.video-dropped-frame-rate` 只属于 run scope：探针停止时枚举仍在当前 DOM 中的 `video`，校验每组 `getVideoPlaybackQuality()` 计数是有界、非负的安全整数且 `droppedVideoFrames <= totalVideoFrames`，再计算 `sum(dropped) / sum(total)`；`samples` 是实际参与计算的 `totalVideoFrames` 总和，不是 video 元素数量。所有表面均可读且总帧大于 0 才是 `measured`；部分表面读取失败但仍有有效帧是 `partial`；无 video、`totalVideoFrames === 0`、读取/校验失败和 API 不支持分别保留。Playback Quality 的 total 是已显示帧与丢弃帧总计，不是纯解码或纯呈现帧。

这个值是停止时累计计数器快照，不是测量窗口起止差值，也不能复制到 click/hover 等 action scope。已经移除的 video 不在快照内，媒体重新 load 可能重置计数；它也没有 decode、GPU upload、first-visible、stall 或逐帧呈现节奏证据。要做动作级视频指标，必须由 media/renderer adapter 在动作 begin/end 建立逐元素基线并处理 reset。跨次 `samples` 求和若超过报告合同的 10,000,000 上限，Runner 仍保留各次值的中位数，但把不再可精确保留的总样本数设为 `null` 并附加限制，不能用截断后的假总数通过预算。

详情页按需显示五个视图：Overview 给重复测量的聚合；Animation 是动画/交互相关的 trace 子集；Performance 是完整有界 CDP 时间线及脱敏栈；Lighthouse 是另一轮 navigation 的分类、核心指标和失败审计；Artifacts 只列平台实际保存且当前有权下载的产物。Timeline/Lighthouse 前端代码按 tab 动态加载，避免诊断 UI 自身增加首屏成本。

页面右下角 SDK 面板与平台 Labs 不复制同一份状态。SDK 面板显示当前真实页面的实时帧率、自动输入窗口、Coverage、页面/renderer surface 和手动选中目标证据，适合开发时即时排查；它不把外部 Runner 的场景声明冒充成本页运行时事实。平台 Labs 显示可复现实验的 action trigger、subject、outcome/window、声明与观测分离的技术证据、版本化预算、跨次聚合、finding、Performance trace 与 Lighthouse。Runner 可通过显式 `--local-display` 在所属终端显示动作位置和最终预算状态；这个 Node-owned 单向 sink 只接收闭集语义投影，不通过页面 global、`postMessage` 或 SDK overlay 建立可伪造的证据通道，sink 失败也不改变测量结果。这样线上 RUM、本地即时观察和可复现实验各自保留正确的证据边界。

本地 runner 永远先写本地产物目录。`trace.json.gz`、完整 Lighthouse JSON/HTML、selector、cookie、request/response body 与凭证属于 local-sensitive，不上传；平台只收不带 timeline、严格不超过 2 MiB 的 `animation-report`，以及事件数和紧凑 JSON 实际字节都受限（最多 4,000 条、4 MiB）的 `trace-index`。热身明细不上传；动作很多时按“高价值指标 × 动作顺序”公平裁剪每次尝试，先完成全量内存聚合再生成传输投影，避免后排动作饿死。Trace 索引优先保留动作 marker、已有动作归因和长耗时事件，同时收紧 stack 深度与 source 文本；原始 trace 不受这个派生视图代替。这使 localhost:3000 能展示 Performance 栈/时间线和 Lighthouse 摘要，但它不是 Chrome Performance panel 的完整替代品：原始 trace 仍应在本地 DevTools/Perfetto 打开，source map 到 authored source 也需要后续离线解析。

### DevTools extension

扩展稳定后放在：

```text
apps/frontend/animation-devtools-extension/
├── manifest.*
├── devtools/
├── panel/
└── bridge/
```

panel 通过页面 bridge 订阅 `packages/animation` 暴露的本地快照。扩展可以增加 source、network、trace 跳转，但不能 monkey-patch 框架或取代页面采集器。

Chrome 扩展落地时按官方边界拆分：DevTools page 创建 panel，content/injected bridge 接入 inspected page，service worker 只承担扩展消息与权限。页面 bridge 必须校验消息来源和闭集 schema；默认不把本地报告转发到 Condev 后端。

## 不同框架的代码放在哪里

| 能力                         | 开发位置                                                                                                                            | 说明                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 所有 Web 页面共同结果        | `packages/animation`                                                                                                                | frame、LoAF、Long Task、Event Timing、interaction、coverage；不依赖框架                                                                                                                                                                                                                                                                                                                                   |
| 原生 DOM/Web Components 目标 | `packages/animation`                                                                                                                | Picker、CSS/WAAPI、几何/连接/Canvas backing pixels；原生是一等实现，不是失败 fallback                                                                                                                                                                                                                                                                                                                     |
| 页面级共享采集运行时         | `packages/browser-utils`                                                                                                            | 一个 rAF clock、每种 entry 一个 PerformanceObserver、共享 Web Vitals、visibility/BFCache 生命周期                                                                                                                                                                                                                                                                                                         |
| React / Next                 | `packages/react` + core Profiler/manual helper                                                                                      | `@condev-monitor/react/animation` 采匿名 public Profiler render/base-render；commit duration 仅接独立实测，后续再补 owner/why-update/hydration                                                                                                                                                                                                                                                            |
| Vue                          | `packages/vue` + core lifecycle update-window                                                                                       | `@condev-monitor/vue/animation` 通过显式 composable 采 `onBeforeUpdate` → `onUpdated` 窗口和匿名真实元素归属；不把 `nextTick` 或生命周期窗口冒充 render/commit/paint/GPU                                                                                                                                                                                                                                  |
| Angular                      | `packages/angular` + core component check-window                                                                                    | 显式接 `ngDoCheck` → `ngAfterViewChecked` 组件检查窗口；`afterEveryRender({ read })` 仅做 application-wide post-render target 同步；decorator-free helper 可供应用自己的 AOT directive 绑定匿名元素，不冒充 DOM update/render/commit/paint/GPU                                                                                                                                                            |
| Svelte                       | `packages/svelte` + core lifecycle update-window                                                                                    | `@condev-monitor/svelte/animation` 使用显式 `$effect.pre` + public `tick()` 采追踪依赖窗口，并用 action 注册匿名真实元素归属；不冒充全组件更新、DOM mutation、render/commit/paint/GPU                                                                                                                                                                                                                     |
| Solid                        | `packages/solid` + core host-work sink                                                                                              | `@condev-monitor/solid/animation` 通过 element-owned directive 注册匿名真实元素并随条件元素 owner 清理；显式 `measureReactiveWork()` 只记录调用方 callback 的 host `script` self-time，不把 effect 间隔冒充 render/update/check/commit/paint/GPU                                                                                                                                                          |
| GSAP / Lenis / ScrollTrigger | core public inventory + 显式等价循环 analyzer + GSAP ticker、Lenis scroll、ScrollTrigger public state observer；后续 motion package | 由宿主传入实例并只读 public API；已能提出有界 post-cleanup 增长候选，观察 ticker cadence、Lenis 闭集 scroll sample，以及 ScrollTrigger progress/active/direction/velocity/span 和六类 global-event 自动 checkpoint；它们仍不判 leak、不冒充页面 FPS，不把 global event 冒充业务生命周期，且暂不进入 RUM                                                                                                   |
| Three / R3F / WebGL / WebGPU | core 通用 renderer-host + Three counter helper + `packages/animation-renderer` + 可选 React R3F observer                            | 已接 Three public counters、外部帧去重、R3F public after-render 被动观察、显式独占 ownership 的 root-scoped `useFrame` → shared after-render 稀疏 GPU timer、context loss、WebGL1/2 async GPU frame timer、WebGPU 单/多 pass timestamp query，以及显式本地 scheduled-upload/readback-ready recorder；后续补 per-family composite/RUM、跨 command buffer、引擎资源、per-pass/post-processing 与内部 target |
| Canvas / media               | Canvas direct + `packages/animation-renderer` Canvas2D recorder + Video RVFC + core media semantic recorder                         | 已有 backing geometry、显式 logical-frame/command/sync readback-upload/context 证据、RVFC/drop delta，以及调用方声明的有界 decode/upload/first-visible 本地阶段；后续补 Worker/内部对象、renderer/browser 实测归因和 visibility                                                                                                                                                                           |
| Chrome F12 UI                | 后续 `apps/frontend/animation-devtools-extension`                                                                                   | 只消费 collector/schema，不再实现一套指标                                                                                                                                                                                                                                                                                                                                                                 |
| Electron / 浏览器 WebView    | `packages/animation` + 后续 host bridge                                                                                             | 标准浏览器信号按 capability 降级；宿主生命周期和设备信息由 bridge 补充                                                                                                                                                                                                                                                                                                                                    |
| React Native                 | 后续 `packages/animation-react-native`                                                                                              | JS/UI thread frame、navigation、native driver 由 iOS/Android bridge 映射到同一 family                                                                                                                                                                                                                                                                                                                     |
| 小程序                       | 后续 `packages/animation-miniapp`                                                                                                   | 每个平台单独 adapter；不能把不存在的 PerformanceObserver 伪装为 0                                                                                                                                                                                                                                                                                                                                         |
| 原生 iOS/Android/Flutter     | 独立平台 SDK，再复用 RUM wire contract                                                                                              | 不属于浏览器子包；需要平台 frame/jank、主线程、GPU 和 lifecycle API                                                                                                                                                                                                                                                                                                                                       |

这些 adapter 只补框架 ownership 和渲染器内部信号。frame p95、INP、Long Task 等用户结果不会因为 React、Vue、Angular、Svelte 或 Solid 而换一套定义；React render/commit、Vue update window、Angular check window、Svelte tracked-dependency window、Solid 显式 callback self-time 和 Three draw calls 也不能直接横向评分。

GSAP、Lenis 与 ScrollTrigger 现在还可以通过 `createMotionSemanticCheckpointRecorder()` 接入显式业务语义窗口：只有业务代码调用 `begin()` 后再调用 `end()`/`cancel()`，才会保留一组有界、local-only 的 before/after public observer 投影。ScrollTrigger global event、ticker callback 和 Lenis scroll event 不会自动创建或完成业务交互；checkpoint 不上传 selector、DOM、URL、host instance 或 observer 原始快照，也不新增 RUM 字段。独立 motion package 和框架/引擎专用 hook 仍属于后续工作。

媒体阶段现在可以通过 `createMediaSemanticStageRecorder()` 显式声明一次 image/video/Canvas/WebGL/WebGPU/custom attempt 的 `decode-ready`、`upload-ready` 与 `first-visible`。开始、阶段和结束时间必须来自调用方同一单调时钟；阶段可以缺省，但接受较晚阶段后不能回填较早阶段。duration、bytes 和 item count 都只是有界的调用方 attestation，不是浏览器 decode、GPU upload 或真实呈现的自动测量。recorder 不读取或控制 media/renderer，不保留 URL/src、selector、label、DOM、host object、任意 metadata 或原始事件；取消结果不会暴露 `firstVisible`。完成记录和活跃 attempt 分别有界，销毁会先密封新输入再确定性取消全部未完成监控窗口。Browser convenience 只补 teardown ownership，不会自动打开 collector interaction、改变现有 interaction 聚合或新增 v1/v2 RUM 字段；需要页面性能相关窗口时，调用方必须在相同业务边界另行显式使用 `client.animation.beginInteraction()`。hidden/offscreen 后必须由宿主重新开始 attempt/基线，SDK 不自动推断可见性或业务完成。

当前目标合同把运行时拆成四个可多值轴：`uiFrameworks`、`metaRuntimes`、`renderers`、`motionEngines`。因此 React + Next + Three + GSAP 可以同时出现。DOM/SVG/Canvas 的直接浏览器证据不依赖框架；但 DOM 节点本身不能证明是 Vanilla、React、Vue 或其他运行时所有，所以没有显式 framework target adapter 时 `uiFrameworks` 为空，由目标自身推断的生产 target RUM framework 为 `unknown`。调用方仍可显式配置页面级 RUM `runtimeFamily`，但它不是目标 owner 证据。原生目标需要由显式 adapter 声明 `uiFrameworks:['vanilla']`；缺少 adapter 不影响 CSS/WAAPI、几何、生命周期与 Canvas 表面证据。

## React Scan 借鉴边界

React Scan 提供了“一行启用、record/pause、低噪声 toolbar、按影响排序、owner/source、why-update、本地优先，以及 inspect-off→inspecting→focused 元素选择状态机”等可参考的产品体验。当前实际落地的是“一行启用 + 右下角折叠入口 + Shadow DOM + 本地即时建议 + 工具自身交互排除 + 一次性准星 Picker + Target 工作区”；收起只暂停面板重绘，不混同为停止采集。Picker 只在 active 状态安装监听器，用全页选择玻璃防止目标控件收到选择 click，Escape 清理，选中后通过标准 DOM sidecar 工作。Target 不自动录制，使用独立 Start/Stop/Reset/Clear 管理有界相关窗口；页面 collector 仍持续运行。core 已提供 React Profiler `actualDuration` 的显式 render evidence helper，但独立 page record/pause、React why-update、组件 owner 和真实 commit duration 仍留给后续 React adapter。

不把 React DevTools 私有 hook、render 次数或持续 DOM outline 作为通用核心，也不让 React adapter 解释 CSS、Canvas 或 GPU 总成本。这样非 React 页面、移动浏览器和自动化 runner 仍能使用相同结果指标。

## Codegrid 语料怎样影响设计

设计依据的本地 Codegrid 导出共解析 9,536 条 2023-01-10 至 2026-08-21 的带时间消息，最近六年窗口覆盖 100%；`unzip/` 的 249 个案例都有可读源码。所有文件均被清点，语义扫描只读取合格的抽取文本/源码；ZIP 副本、媒体、模型、依赖、generated/minified 输出没有被伪称为源码阅读。

语料反复组合 GSAP/ScrollTrigger/Lenis、React/Next、Three/WebGL/shader、Canvas、SVG、media、连续输入和移动端兼容，因此它决定了上面的 adapter 与默认测试场景。关键词数量和静态 cleanup/DPR/layout 命中只是重叠的 review candidate，不是采用率、线上问题数或优先级；是否修改仍必须由同一路由、同一语义交互的运行时证据确认。

真实站点示例放在 `examples/animation-fixtures`。当前保留三个已获再分发授权、互相补充的项目：Lemon Bureau 覆盖原生 Vite + Three/WebGL/Canvas，Nico Palmer 覆盖 React 19 + Framer Motion + GSAP/Lenis，Salle Blanche 覆盖 Next 16 + React 19 + GSAP/Lenis/View Transition。三个项目都在原有浏览器入口调用一次 `@condev-monitor/monitor-sdk-browser/animation` 的 `init()`。Nico Palmer 和 Salle Blanche 仍只直接依赖 Browser SDK，不接框架或 renderer 深层 probe；Lemon Bureau 另外直接依赖 `@condev-monitor/monitor-sdk-animation-renderer`，在现有 Three 页面接入公开计数 adapter 和稀疏 WebGL timer。所有接入都不改业务组件树。

Lemon Bureau 在五个页面共用的 `js/lenis-scroll.js` 初始化 Browser client，并在 `js/contact.js` 的 caller-owned Three render loop 接入 renderer adapter/WebGL timer；Nico Palmer 在 `src/main.jsx` 初始化，Salle Blanche 使用 Next.js 官方的 `src/instrumentation-client.js`。开发模式默认只在本地显示动画面板；只有调用方显式提供公开 DSN 时才启用动画 RUM。示例不包含 `.env`、私有上游缓存、生成报告、注入 harness 或专用 runner，验证以 SDK 导出检查、三个项目的 production build 和人工浏览器 smoke test 为准。

本次也对 Condev Monitor 仓库自身做了独立静态审计：共枚举 334,373 个文件，读取 4,752 个合格文本文件和 704 个 source-like 文件，对 651 份去重源码做规则分析，得到 8 类 review candidate。高等级样本主要来自 `.open-next` 生成物，不能作为源码缺陷；唯一指向手写 Three.js 组件的 shader 创建位于 `useMemo` 初始化路径，不是逐帧热循环。它仍值得在真实页面用 frame tail、renderer 资源计数和 mount/unmount 循环复测，但当前没有运行时证据支持把它写成已确认回归。

这次扫描证明的是“源码候选已清点”，不是性能 Before/After。依赖、压缩生成物、媒体、archive、模型和二进制只做 inventory；没有把它们伪称为人工语义阅读，也没有用静态命中替代真实浏览器测量。

## Codrops All Posts 怎样补全指标

2026-08-25 的本地离线审计重新确认 `codrop-all-posts` 有 1,724 篇、10,384 个文件，21 项归档检查全部通过，pending/failed/conflict 均为 0。1,666 篇 canonical + 2 篇 exact-ID 可做正文语义解析；56 篇 legacy opaque 受既有权利边界约束，只能验证正文哈希，不能声称读过其正文。严格 trailing six years（2020-08-25 起）为 842 篇，其中 841 篇可解析、1 篇 opaque；全量文章结构有 17,206 个 code block，但它们不是已保存并运行验证的 demo 源码。

全量/近六年文章反复出现的实现链是：资源和尺寸准备 → input/scroll/drag/audio 采样 → target/current/progress/velocity 分离 → CSS/GSAP/rAF/render loop 调度 → DOM/SVG/Canvas/WebGL/WebGPU 输出 → wrap/reuse/pause/degrade/destroy。它把当前缺口明确分成：

1. 目标 direct：标准动画清单、属性类别、DOM/SVG write、path/filter、resize 与目标可见性；
2. 输入和动效质量：input-to-first-visual、sample age、coalesced event、progress/alignment error、settle/overshoot、控制器冲突；
3. renderer：CPU/GPU frame、pass/draw/primitives、resource/live gauge、upload/readback、DPR/target pixels、context/device loss；
4. lifecycle/work avoidance：active rAF/ticker/listener/observer、route 前后 delta、资源斜率、hidden/offscreen work、十分钟 soak；
5. accessibility：reduced-motion 实际违规、autoplay pause、键盘/触控等价与 Canvas/WebGL 语义 fallback。

本轮已经补上其中的基础证据合同：target direct 的 Canvas 分轴尺寸/resize；连续交互的 input-to-visual、sample age、coalesced、progress/alignment、settle/overshoot 和 controller conflict；五类 page-level host evidence sink，以及 framework commit、通用 renderer-host、Three counter、GSAP lifecycle、Video RVFC helper。通用/Three/GSAP/Video helper 可以从显式传入的宿主 public evidence 读取闭集值；可选 renderer 包额外执行独占、稀疏、非阻塞的 WebGL1/2 GPU frame query，需宿主显式声明完整单 pass 或同一个 command buffer 首/末 pass 边界与关联 submit 的 WebGPU timestamp query，以及显式 WebGPU scheduled-upload/readback-ready 本地记录。它们仍不自动发现 framework owner、不协调 WebGPU 跨 command buffer/submit 或引擎私有 encoder、不提供资源 per-family composite/RUM、不做 heap/post-GC 泄漏判定，也不接管业务 cleanup。

因此当前指标不是“少到无效”，而是 browser-core v1 已覆盖页面结果层，Resource Timing 和显式 host helper 覆盖一部分专项证据；通用 framework 自动归因、完整 renderer/media、heap/lifecycle analyzer 仍缺。新增指标必须按上述家族逐步进入 adapter，不能把文章关键词数量当技术采用率，也不能把静态文章模式直接当某个运行页面已经存在的性能问题。

## 本地报告与生产 RUM 不能混用

本地报告可以保留有界帧尾、完整 coverage 和建议；LoAF source candidate/source-map 定位留在后续本地工具中实现。生产 RUM 只允许上传版本化 summary：

- event/capture ID 和 captured/received time；
- release、dist、environment、脱敏 route key；
- target frame budget、来源和置信度；
- 有界 measurement window 及是否被截断；
- p50/p75/p95/p99/max、slow rate、burst；
- LoAF/Long Task/Event Timing 的有界聚合；
- capabilities、coverage、sampling policy；
- monitor callback count、report-build p95 自耗时和 callback self-time / measurement-window 比例。

默认禁止 userId/email、referrer、完整 User-Agent、query/hash、selector、typed value、DOM、截图、完整资源 URL、原始逐帧数组、原始 keyframes 和任意 custom payload。

`captureSufficiency`、visible/hidden/other duration、document-lifetime `webVitals` latest、capture-window `resourceTiming`、完整 `hostEvidence`、本地 Target 描述、renderer 原始证据和 Canvas 分轴几何等详细结构仍只存在本地 `AnimationSnapshot`/Target snapshot。线上报告从不 spread 本地快照：`animation_rum` v1 继续按固定 capability、coverage family 和闭集 metric 逐项重建；显式启用的 RUM v2 也只投影版本化目录中允许的聚合 metric、capability、coverage 与 provider evidence。当前 v2 已能投影页面/目标 renderer 的 GPU p95、draw calls p95、triangles p95 等闭集值，但不会上传完整 host sample、adapter 名、scene/object、selector、URL 或 shader。对应闭集由 SDK、DSN、Worker、ClickHouse 与 Monitor 同步维护，未知 key 在信任边界被拒绝。共享 Web Vitals runtime 中的旧通用 Metrics 上传仍是另一条既有 `performance` 事件路径；animation 的 Resource DTO 也在共享分发前去除 name/URL。

目标隐私同样分本地与上报，但不能混用合同：

- 已实现的 `local target` 默认只在页面内存展示；可以显示有界 tag/标准 role、调用方 adapter 的 owner label/source candidate 和关键帧属性名，但不读取 id/class/text/input value/props/state/URL/像素/shader source，也不写 localStorage；
- SDK-owned `inspectionPurpose` 把 Overlay/公开选择标成 `'local'`，把 RUM v2 target sidecar 标成 `'rum'`。当前 WebGPU transfer inspector 只接受精确 `'local'`，并在 RUM、context 缺失或 purpose 缺失/无效时返回 `null`；这项保证只属于该 recorder，不能推导其它 adapter 已被统一排除；
- interaction quality 只接受闭集有界数值，忽略任意额外字段，不接收 pointer 坐标轨迹、输入值、selector、owner 名、场景名或自定义 payload；
- page-level `animation_rum` v1 继续要求显式 `rum.enabled`、采样命中并通过严格 allowlist；Target 详情完全不进入 v1；
- 已实现的 RUM v2 仍需显式 `contractVersion:2`、采样命中和静态脱敏 `routeKey`。只有调用方明确注册的语义目标才能用静态 `targetKey` 产生 target aggregate；Picker 选择不会被自动升级为线上目标；v2 只发闭集数值/bucket/capability/coverage/provider evidence，不发本地 descriptor/source/raw sample。哈希低熵 selector 也不等于匿名，SDK 不会自动生成；
- v2 为 page/target 提供独立 scope/event identity 和 parent relation。ClickHouse 使用通用 metric/provider 子行与 completion marker；查询端会核对 marker expected count、`FINAL` observed count、event/scope identity 和闭集 mapper。缺行、额外行或被替换的子行不会作为部分证据返回：summary/list 会排除不完整 capture，详情返回 409 `ANIMATION_RUM_V2_PROJECTION_INCOMPLETE`。

Monitor backend 的读接口包括：

- `GET /api/animation/summary`：按所属应用和最长 90 天窗口返回 capture-level 聚合；
- `GET /api/animation/captures`：返回一个或多个 capture 的闭集 context、capabilities、coverage 与 metrics。
- `GET /api/animation/rum-v2/summary`、`/pipeline`、`/captures`、`/captures/:captureId`：返回通过 v2 projection integrity 核对的聚合、管线状态、列表与详情。

两者都要求 JWT 并在 controller 内执行 application ownership 校验。DSN server 只有受限写入口，没有只凭 `appId` 的 animation 读接口。

部署时，仓库的 `pnpm docker:deploy` / `pnpm docker:start` 会幂等重放 ClickHouse schema，因此已有 volume 也能得到 `004_animation_rum_v1.sql` 与 `005_animation_rum_v2.sql`。如果绕开这些脚本单独升级服务，必须先执行 `pnpm docker:init-clickhouse`，再开放 animation RUM 写入或查询。

Animation RUM 与其他监控表统一使用 `CLICKHOUSE_DATABASE` 指定的库；默认值是 `lemonade`，旧 `CLICKHOUSE_DB` 仅作为兼容回退。初始化脚本会在执行未限定库名的 schema 前校验并选择该数据库，Monitor、DSN 与 Event Worker 使用同一解析和标识符校验规则。

### Animation RUM v2 真实发布门禁

`pnpm test:animation-rum-v2:release` 串行执行两层真实数据测试：先验证 DSN admission → PostgreSQL Outbox → Kafka/Event Worker → ClickHouse，再验证 Monitor 对真实 ClickHouse 表的 summary、trend 和 projection-integrity 查询。门禁覆盖 GPU `measured: 0 ms` 不被当作空值、`unsupported: null`、六种指标状态计数，以及 event identity 不匹配的陈旧子行不能进入统计且详情返回 409。

该命令不会自动执行 `docker:start`、`start:dev`，不会读取或修改 `.env`，也不会硬编码数据库凭据。运行前必须确保基础设施、DSN 和 Event Worker 已启动，并通过当前 shell 一次性提供以下变量：

```sh
TEST_POSTGRES_URL='<与当前 DSN 服务相同的测试数据库连接>' \
TEST_CLICKHOUSE_URL='<ClickHouse HTTP 地址>' \
TEST_CLICKHOUSE_USERNAME='<ClickHouse 用户>' \
TEST_CLICKHOUSE_PASSWORD='<ClickHouse 密码，可为空>' \
TEST_CLICKHOUSE_DATABASE='<ClickHouse 数据库>' \
TEST_DSN_BASE_URL='<DSN 服务基地址>' \
TEST_ANIMATION_RUM_V2_PIPELINE_WRITE_SENTINEL='condev-animation-rum-v2-pipeline-e2e' \
pnpm test:animation-rum-v2:release
```

DSN 测试默认要求 Kafka transport；显式测试 direct ClickHouse fallback 时可另传 `TEST_ANIMATION_RUM_V2_EXPECTED_TRANSPORT=clickhouse`。每次运行只创建带随机前缀的应用与 capture，`finally` 中按精确 application/appId 清理 PostgreSQL 和三个 v2 ClickHouse 表，并用同步 mutation 加 `FINAL count()=0` 验证没有残留。`TEST_POSTGRES_URL` 若指向与运行中 DSN 不同的数据库，服务会正确返回 `RUM_V2_NOT_ENABLED`；这属于环境连接不一致，不是报告 schema 失败。

Kafka 是追加日志，门禁不会也不能从共享 topic 中删除已经发布的测试消息；这些消息会保留到 topic retention 到期。如果 consumer group 被重置为从头消费，旧夹具可能再次投影。因此这条命令只允许连接本地或隔离的一次性测试 Kafka/topic，绝不能指向共享生产基础设施；需要严格零留存的 CI 应为每次运行提供隔离 topic/cluster，并在任务结束后销毁它。

## 仍未实现的证据层

当前的 `not-instrumented`/`unsupported` 不是遗漏的 0。下列能力还需要单独实现和验证：

1. 完整 framework/motion adapters：React/Next owner/why-update/真实 commit、Vue/Angular/Svelte 深层 owner/why-update、Solid 深层 computation/why-update、Angular partial-compiled directive/APF 与 20/21/22 AOT consumer 矩阵，以及独立 motion package 与框架/引擎专用 hook；GSAP/ScrollTrigger 当前已有公开 inventory、不上传任何 cycle 标识的显式等价循环 analyzer、standalone ticker observer，以及 public instance/global-event observer，Lenis 也已有 standalone public scroll observer。`createMotionSemanticCheckpointRecorder()` 已能在调用方明确 `begin()` → `end()`/`cancel()` 时，把三类 public observer 收缩为有界、local-only 的 before/after 业务语义证据；它不会从 global event 自动推断业务开始/完成，也不把 observer checkpoint 投影到 RUM。增长候选仍不是 leak 结论、ticker delta 不是页面 FPS、ScrollTrigger global event 不是 route/interaction/animation-complete、Lenis velocity 也没有 px/s 声明；React 只接显式 public Profiler，Vue 只接显式 public lifecycle update-window，Angular 已接显式 public component check-window、application-wide post-render target 同步和供 app-local directive 使用的 decorator-free target binding，但没有发布未经 partial compilation 的装饰器产物，Svelte 只接显式 tracked-dependency `tick()` window，Solid 只接匿名 owner 与调用方显式同步 work self-time，它们都没有私有全树归因；
2. 完整 renderer/media adapters：Pixi 的稳定公开映射、Babylon 的 GPU/resource/target lifecycle、Three/R3F 的 per-pass/post-processing/内部对象映射，WebGL/WebGPU 的跨 command buffer、upload/readback/context/device 数据，Canvas2D 的 OffscreenCanvas Worker 时钟桥接、内部命中、异步编码/transfer 与完整业务资源归因，以及 renderer/browser 实测的 media decode/upload/first-visible/visibility；当前 Three adapter 已接 caller-owned render wrapper 与 external-frame capture，React 的可选 R3F observer 默认通过 public after-render 被动采集并按 renderer frame 去重，显式独占 disjoint-query ownership 时则以 root-scoped public `useFrame` 开始、shared public after-render 完成稀疏 WebGL GPU timer；Babylon 已接公共 SceneInstrumentation 的页面级 draw-call 观察，但没有 GPU、triangle、资源或内部对象归因。Pixi v8 的 renderer post-render 与 pipeline counters 仍是内部 API，不能因可读取就标成支持。R3F adapter 仍不接管 loop，不能覆盖更早的 global/equal-priority callback work，不证明 compositor present，也不提供 mesh/component/pass 归因；Canvas2D recorder 已接宿主显式完整逻辑帧、闭集 command、同步 readback/upload、backing/context 证据，WebGL timer 已接 whole-canvas Target query window，通用 renderer-host/Video helper 也已接公开状态，core media semantic recorder 可保留调用方声明的本地阶段，但引擎资源、内部对象、真实媒体管线归因与生命周期语义仍不完整；
3. GPU query 后续：WebGL1/2 已有可选的异步、稀疏、非阻塞 frame timer，并验证 availability、disjoint、context loss、独占 ownership、队列、一次性 host 消费和有界 Target window；WebGPU 已有 feature-gated 单完整 pass、同一 command buffer 首/末 pass 区间、submit 后异步 map、device-loss 终态和乱序 sample 防回流的 timestamp timer；仍缺 WebGPU 跨 command buffer/submit 与引擎私有 encoder 协调、跨重复 bundle 的强制仲裁、真实设备 capability/开销矩阵与引擎自带 profiler 协调；
4. CDP/trace 深层归因：首版 Labs 已有有界 JS、style/layout、paint/composite、raster/GPU 类别时间线与脱敏生成源码栈；仍缺 source map 到 authored source、逐帧 layer/CPU profile 专门视图和跨浏览器等价实现。浏览器 SDK 的 LoAF tail 和可选 PaintTimingMixin 只覆盖长帧，不能替代全帧 trace、源码归因或真实 GPU timer；
5. resource/media/lifecycle 深层证据：resource-to-first-visible、renderer/browser 实测的 media decode/upload/first-visible、route/unmount 前后 listener/observer/ticker/resource/heap delta、hidden/offscreen work，以及代表设备至少十分钟 soak/post-GC plateau；调用方 attested 的本地 media stage 已有，但不能替代这些实测证据；
6. soft-navigation Web Vitals、跨源 iframe/OffscreenCanvas Worker bridge、inner-scene hit-test，以及经过新版本数据合同授权的 target/quality RUM。

这些能力落地前，建议只能基于已经观测到的 browser/host evidence；不得由静态文章模式、单个 draw count、DPR 或缺失值推导已确认问题。

## 推荐发布顺序

1. integration/client 生命周期与共享 browser runtime；
2. `packages/animation` 本地 collector、测试和 overlay；
3. `examples/animation-fixtures` 三个单-init 示例的 build 与浏览器 dogfood；
4. 已落地 Chromium Labs 后继续补多浏览器、多刷新率、visibility、reduced-motion 和框架/renderer 场景；
5. RUM projection、后端严格契约、采样和专用存储；
6. Dashboard overview/capture detail；
7. 最后开发 DevTools extension 与更深 authored-source 归因。

每次性能优化都必须在相同 route、build、浏览器、设备、视口、缓存、节流、动作顺序、时长和 monitor capability 下做重复 Before/After；一次最快结果和平均 FPS 都不能证明优化成功。
