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

Labs 不是要求真实用户打开 DevTools 的功能。它是一个从命令行启动的浏览器中立 runner，当前 Playwright adapter 支持 Chromium、Firefox 和 WebKit：三个引擎都能按本地 JSON 场景重复执行 pointer、hover、click、scroll、drag、keyboard、resize 等动作并运行页面 probe；CDP Performance trace 和 Lighthouse navigation 只在 Chromium 中可用。Chrome Network 面板的 “Preserve log/保留日志” 从不参与采集；页面 SDK 由 transport、离线队列和生命周期 flush 负责生产上报，Labs 由 runner 直接写本地产物并用授权 API 上传脱敏派生结果。

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

`client.animation.createFrameworkProbe()`、`createGsapProbe()`、`createThreeProbe()`、`createVideoProbe()` 只是在同一 collector 上补宿主证据，不会第二次 init，也不会创建第二个 rAF。Browser animation 入口默认开启隐私安全的粗粒度 load、pointer/click、真实 scroll、仅 fine pointer 的 hover/pointer-motion、keyboard、window resize 与 VisualViewport resize/pan 窗口；`autoInputWindows: false` 可以整体关闭，对象配置可以逐项关闭或调整有界 quiet period。自动窗口只保留 SDK 固定标签和时间边界，不保留坐标、按键值、selector、元素文字、输入值或原始事件，也不会捏造 input-to-visual、pointer sample age、progress/settle 或 GPU 数据。它们不能冒充业务动画已经完成；真实业务边界仍应调用 `client.animation.beginInteraction()`，独立测得的质量再通过 `recordQuality()` 写入。

同一个 Browser 入口现在还默认启动有界的本地 `snapshot.pageEvidence`：整页匿名 CSS/Web Animations 清单与生命周期计数、页面 video 的 RVFC/playback-quality probe、SVG/Canvas 表面数量、未来成功 `getContext()` 的 Canvas2D/WebGL/WebGL2/WebGPU 分类，以及 hidden/offscreen/reduced-motion 复核候选。自动 video probe 以 250–1,000 ms 的有界节奏聚合，不会每个解码回调都写一条 host sample。`autoPageEvidence: false` 可整体关闭，对象配置可分别关闭 `animations/media/rendererSurfaces/visibility/reducedMotion` 并调整采样和容量。它绝不保存动画名、selector、文字、属性值、keyframe、URL/src、坐标、按键、输入值或原始事件。页面只能把“隐藏时仍为 running”“离屏 target 仍为 running”“reduce 下仍存在运动”写成 candidate，不能证明实际执行了可避免工作或构成无障碍违规；普通 Canvas 表面也不能证明 draw call、GPU time、框架 owner 或业务完成。上述字段只存在本地 Browser snapshot，不进入 `animation_rum` v1。

## 第一版已经覆盖什么

当前第一版是“浏览器标准核心”，不是宣称一次完成所有框架内部归因：

- 已实现：可见 rAF frame tail、刷新率预算、慢帧、missed-display、burst、LoAF、Long Task、Event Timing 三阶段、语义 interaction、12-family coverage、监控自身回调开销、本地建议和 Shadow DOM overlay；
- 已实现：`captureSufficiency` 的 5 秒可见窗口、30 个保留帧、低置信度与截断门槛，并分别记录 visible/hidden/other duration；
- 已实现：共享的 document-lifetime CLS/INP/LCP 运行时、脱敏本地 latest snapshot，以及连续交互 `recordQuality` 的闭集字段、边界、丢样和拒绝统计；
- 已实现：默认整页匿名 CSS/WAAPI 清单、video RVFC、SVG/Canvas/已观察 context family、hidden/offscreen/reduced-motion 候选；页面 collector 始终运行时的并行 DOM Picker/目标 sidecar；Target 的 Start/Stop/Reset/Clear；属性候选、连接/尺寸、Canvas 分轴 backing scale/resize，以及 renderer evidence/GPU fail-closed 公共契约；
- 已实现：显式且稳定的 production sampling、匿名 `animation_rum` v1、严格 DSN/Worker 双重校验、独立 ClickHouse 表、JWT + application ownership 查询和 `/animations` 控制台；
- 已实现本地 capture-window Resource Timing 聚合，以及 framework/renderer/lifecycle/work/media 五类有界 host evidence sink；已提供 React Profiler/manual commit、Three `renderer.info`、GSAP/ScrollTrigger public API 和 Video RVFC/playback-quality 的无宿主依赖 helper；
- 已实现首版受控 Labs：Chromium/Firefox/WebKit 通用动作与页面 probe、重复 warmup/measured 场景、Chromium 独立 CDP trace 和 Lighthouse、原始产物本地保存，以及有界脱敏 timeline/report 上传；平台 `/labs` 展示 Overview、Animation、Performance、Lighthouse 与 Artifacts；
- 下一阶段是把显式 helper 接入真实应用/框架 adapter，并补 Vue/Angular/Svelte/Solid 宿主归因、真实异步 GPU query、heap/route soak、decode/upload/first-visible 等深层证据；
- 后续再开发 Chrome DevTools extension、source map 到 authored source 的离线解析、WebDriver BiDi/Selenium/Grid adapter 与真实设备矩阵；这些不会替代已经落地的页面浮层或 Labs。

同一浏览器标准核心可用于原生页面及 React、Vue、Angular、Svelte、Solid 等 Web 框架，也能在支持相同 API 的 WebView 中降级运行。它不能凭浏览器 API 猜出 React commit、Vue update、Three draw call、GPU timer 或 native React Native 动画；这些数据必须由宿主 adapter 显式提供，并继续输出同一个有界合同。`unsupported` 或 `not-instrumented` 就是正确结果，不能为追求“全支持”而填 0。

## 本地 host evidence API 与边界

`AnimationCollector` 与 `AnimationIntegration` 都可以作为闭集 sink，公开相同的五个方法：

| 方法                     | 输入语义                                                                               | 会影响的 coverage（最多）                        |
| ------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `recordFrameworkStats()` | framework、mount/update/hydrate phase、render/base-render 与独立测得的 commit duration | 本地 framework work；不单独改变 `workAvoidance`  |
| `recordRenderStats()`    | Three counters 与 fail-closed GPU timer evidence                                       | `renderer: partial`                              |
| `recordLifecycleStats()` | 明确 checkpoint 上的 GSAP animation / ScrollTrigger inventory                          | `memoryLifecycle: partial`                       |
| `recordWorkStats()`      | 宿主实测的 script/layout/paint/composite/other duration                                | 本地 work 明细；不单独证明 avoidable/hidden work |
| `recordMediaStats()`     | RVFC cadence/presentation timing 与 playback-quality delta                             | `resourcesMedia: partial`                        |

每个 family 默认保留 256 个、最多 4,096 个 sample。collector 忽略调用方的采集时钟并使用自己的单调 capture time；无效、非有限、越界或内部矛盾的样本会拒绝，ring 丢样保持显式。摘要固定在 `snapshot.hostEvidence.scope: 'capture-window-local'`，分别给出 accepted/retained/dropped/rejected/evidence sample：`acceptedWindow` 是全量 accepted 的时间跨度，`window`、分位数、分类计数和 delta total 只描述 retained bounded tail（`detailScope: 'retained-samples'`）；发生截断时不能把 tail 冒充全窗。接口没有任意 family、任意 metadata 或 custom payload 通道。

核心包导出以下无宿主依赖 helper：

```ts
import {
    AnimationCollector,
    createFrameworkCommitProbe,
    createGsapLifecycleProbe,
    createThreeRendererProbe,
    createVideoFrameProbe,
} from '@condev-monitor/monitor-sdk-animation'

const animation = new AnimationCollector()
animation.start()

const framework = createFrameworkCommitProbe({ sink: animation, framework: 'react' })
// React: <Profiler onRender={framework.onReactProfilerRender}>…</Profiler>

const three = createThreeRendererProbe({
    sink: animation,
    renderer,
    backend: 'webgl2',
    readGpuTiming: () => gpuTimer.readLatestResolved(),
})
three.capture()

const gsapLifecycle = createGsapLifecycleProbe({ sink: animation, gsap, scrollTrigger: ScrollTrigger })
gsapLifecycle.capture('mount')
gsapLifecycle.capture('after-interaction')
gsapLifecycle.capture('unmount')

const videoFrames = createVideoFrameProbe({ sink: animation, video })
videoFrames.start()
```

上例的 `animation` 可以是已经 `start()` 的 `AnimationCollector`，也可以是已经完成 client `setup()` 并处于 running 的 `AnimationIntegration`；collector 未运行时五个 `record*` 方法都会返回 `false`。这些 helper 只读取调用方显式交给它们的公开能力；`packages/animation` 不 import React、Three、GSAP 或 ScrollTrigger，不 monkey-patch 框架，也不扫描框架私有 hook。它们不会自动创建 `beginInteraction()` 业务窗口；需要业务级关联时，应用仍须在代表动作周围显式创建 interaction/quality window。它们也不创建、播放、暂停、kill 或 dispose 业务动画/renderer/video；应用拥有并控制业务生命周期，探针的 `dispose()` 只清理探针自己的观察状态。

`createFrameworkCommitProbe()` 的 React Profiler callback 把 `actualDuration` 记为 `renderMs`、`baseDuration` 记为 `baseRenderMs`，把 `commitTime` 仅当时间戳。React Profiler 没有在这里提供 commit 阶段耗时，绝不能把 `actualDuration` 或 `commitTime` 冒充 `commitMs`；只有宿主独立测得 commit duration 时才通过 `recordCommit({ commitMs })` 写入。Vue/Angular/Svelte/Solid/vanilla 也可以使用 manual probe，但这不等于已经实现它们的自动 owner/update adapter。

`createThreeRendererProbe()` 读取 public `renderer.info` 的 calls/primitives/geometries/textures/programs 和可选 context-lost 状态。GPU time 采用 fail-closed：只有已完成的有限异步结果同时满足 `valid:true`、`disjoint:false`、`contextLost:false`，且 source 属于 `webgl-disjoint-timer-query`、`webgpu-timestamp-query`、`host-timer-query`，才作为 measured 保存。探针不创建真实 query、不调用 `gl.finish()`，也不把 `performance.now()` 包围 `render()` 的 CPU submission 冒充 GPU time；真实 adapter 必须在渲染循环外稀疏发起/轮询异步 query，让 `readGpuTiming` 只读取已经 resolve 的结果。

`createGsapLifecycleProbe()` 只使用 `globalTimeline.getChildren()` 和 `ScrollTrigger.getAll()` 公共 API，不读 private ticker，也不会在 `dispose()` 中调用 `kill()`。单次 total/active count 只是 inventory，不是泄漏结论，`growthCandidate` 因此固定为 `null`。至少运行三次等价的 mount → 同一代表交互 → 应用自行 cleanup/unmount 循环（推荐五次），在相同 route/build/输入/等待条件下比较 post-cleanup plateau，才有资格提出增长候选；没有 heap/post-GC 证据时仍不能断言内存泄漏。

`createVideoFrameProbe()` 只调度/取消 `requestVideoFrameCallback` 观察，不调用 `play()`/`pause()`，也不改 `src/currentSrc`。第一条 RVFC callback 只建 baseline，不产生 delta；时钟、presented counter 或 playback-quality counter 回退后同样重建 baseline，避免把 seek/source reset 误报成负值或巨量掉帧。页面从 hidden/offscreen 恢复到 visible 时，宿主必须调用 `resetBaseline()`；它只重置测量基线，不控制视频播放，可避免把后台暂停期间误记成一条巨大的 callback/media delta。`getVideoPlaybackQuality().totalVideoFrames` 是浏览器的累计 playback-quality total，探针只使用相邻 callback 的 delta；它不是 decoded-frame count。RVFC metadata 的 `presentedFrames` 是另一条展示计数，不能与前者互换。

以上宿主字段、计数、类别和宿主派生的专项 coverage 全部本地有界，不进入严格 `animation_rum` v1；启用现有 RUM 也不会上传 `hostEvidence`。但既有页面结果指标和总体 `monitorOverhead` 仍会如实反映页面表现与探针真实成本，“本地”不等于“零开销”。它们在本地把 `renderer`、`resourcesMedia`、`memoryLifecycle` coverage 提升到的上限仍是 `partial`；`workAvoidance` 在没有明确 hidden/offscreen/avoided-work 协议前保持 `not-instrumented`。尚缺 heap/post-GC plateau、完整 route/resource cleanup、真实 async GPU query、decode → upload → first-visible、通用框架自动 owner/update 归因和 CDP pipeline trace。缺口必须继续显示为缺口，不能因 helper 已接入就标成“全覆盖”。

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

Target snapshot 的每个 renderer 输出现在都带归一化 `evidence`：window 的 start/end/duration，accepted/retained/dropped/rejected sample count，是否 truncated，以及 GPU validity。adapter 的原始 evidence 输入可以省略；省略时输出仍保留这些字段并使用 `null`/闭集 rejection reason，而不是制造 0。已提供的样本数量必须满足 retained + dropped = accepted；未知或不一致的数值会保留为 `null`。

- Canvas2D：逻辑帧 CPU、draw/path/text/image 次数，`getImageData`/`putImageData` readback/upload 时间与像素，backing-store resize，离屏 canvas 数量；
- WebGL/Three/Pixi/Babylon：CPU submission、有效且非 disjoint 的 GPU timer、draw call、triangle/point/line、program/pipeline、geometry/material/texture/render target、render-target pixels、buffer/texture upload、readback、shader compile、context loss/restore 和 dispose；
- WebGPU：render/compute pass、dispatch/workgroup/storage texture、buffer/texture bytes、有效 timestamp query、device lost、异步 readback；
- media texture：RVFC cadence、presented/dropped、decode→upload→first-visible、hidden/offscreen pause；不读取或上报 `src/currentSrc`。

`performance.now()` 包围 `render()` 或 `queue.submit()` 只能叫 CPU submission，不能冒充 GPU time。`gpuFrameMsP95` 采用 fail-closed：只有 adapter 同时声明 `valid:true`、`disjoint:false`、`contextLost:false`，且 source 为 `webgl-timer-query`、`webgpu-timestamp-query` 或 `host-summary` 时才保留。未报告、无效、validity unknown、disjoint、context lost 或 source unknown 都输出 `gpuFrameMsP95:null` 和闭集 `rejectionReason`。这只是证据校验合同；SDK 目前没有替宿主执行真实 GPU query。DOM Picker 只能选中 canvas 宿主；Three mesh、Pixi display object、Babylon mesh 等内部对象需要 renderer 的 raycast/hit-test adapter，跨源 iframe 和 OffscreenCanvas Worker 需要各自 bridge。

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
- Resource Timing 在分发前移除 name/URL，并共享 `resourcetimingbufferfull` 生命周期监听；
- snapshot/stop/hidden/pagehide 和最后一个订阅者退出前，通过同一脱敏分发路径同步 `takeRecords()`，不漏掉仍在 observer queue 的尾部 entry；
- visibility、pagehide/pageshow 和 BFCache 生命周期；
- 一个进程/文档级的 CLS/INP/LCP multiplexer，向 animation 提供 live + replay-latest，向旧 Metrics 提供 final delivery；
- Web Vitals DTO 只保留 value/delta/rating/navigation type 与闭集数值归因，不传播 DOM、selector、URL 或 raw entry；
- feature detection 与最后一个订阅者退出后的清理。

它已经解决 animation 与旧 RuntimePerformance 重复创建 observer/rAF 的问题，也让 animation 与旧 Metrics 共用同一套 CLS/INP/LCP observer。旧 Metrics 的 final cadence 和 `performance` event name/value/path 保持兼容；animation 的本地 live snapshot 不额外生成 `animation_rum` v1 指标。

### `packages/core` 与 `packages/browser`

- `packages/core` 定义 integration 生命周期和 transport 契约；
- `packages/browser` 创建稳定 client handle，协调 integration finalize、transport flush 和 destroy；
- animation 通过显式 integration 接入，不进入 browser SDK 的默认 bundle；
- lifecycle flush 在线时发送，离线时先等待持久化；持久化失败则恢复内存队列，不静默丢弃；
- 旧 `performance` 事件保持兼容，但逐步迁移到共享运行时，避免重复采集和重复上报。

离线 flush 的 Promise 现在会等待 IndexedDB 写入，失败时恢复内存队列；但浏览器可在 page termination 的任意时刻终止异步事务，最终 durable 仍必须用真实 Chrome/Firefox/Safari 的 pagehide/offline 场景门禁验证，不能只凭 Node 单测承诺“绝不丢失”。

### 后端

| 目录                        | 职责                                                                                                                                         |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/backend/dsn-server`   | 公开但受限的 animation RUM 写入口；严格校验 schema、大小、隐私、appId、采样元数据和 v1 精确 metric tuple；不提供公开读 API                   |
| `apps/backend/event-worker` | Kafka 二次校验、幂等投影和专用 ClickHouse 表；无效 SDK envelope 的 DLQ 不保存原文；聚合当前在 Monitor 查询时完成                             |
| `apps/backend/monitor`      | JWT + application ownership 下的 Animation 查询与 Labs 控制面；Labs 使用 2 小时 runner grant、流式 artifact、严格 schema/大小和 7 天访问期限 |
| `apps/backend/lab-runner`   | 用户/CI 本机的浏览器中立场景执行器；三引擎跑通用探针/动作，Chromium 另有 CDP/Lighthouse，只上传有界脱敏 report/trace-index                   |
| `.devcontainer/clickhouse`  | production animation capture、metric、diagnostic 表及 TTL                                                                                    |
| `.devcontainer/postgres`    | Labs run、一次性 grant hash 和 artifact 元数据                                                                                               |

生产读接口必须位于有租户鉴权的 Monitor API；不能继续把只凭 `appId` 的查询放在 DSN controller。

### Dashboard

`apps/frontend/monitor` 中开发：

- `/animations`：已实现跨 capture 指标聚合和最近采集；`count`/`sum` 不直接横比 raw total，而以 `windowDurationMs` 换算每分钟后再聚合；后续增加 route、release、device 的可视化筛选；
- `/animations/[captureId]`：已实现匿名 context、frame/main-thread 指标、capability 和 12-family coverage；本地 raw timeline 不进入 RUM；
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

默认诊断合同固定为 60 Hz（16.666667 ms），不是根据已经变慢的页面自校准。内置调查规则是 frame p95 `<=1.5×frame budget`（至少 120 帧）、slow-frame rate `<=5%`（至少 120 帧）、jank burst `<=0`（至少 120 帧）、Long Task count `<=0`（至少 1 个样本）和 input delay p95 `<=100 ms`（至少 3 个事件）。这些是版本化项目预算，不是浏览器标准或跨业务统一评分；高刷场景应在 scenario 明确写入 refresh contract。

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

| 能力                           | 开发位置                                                                                             | 说明                                                                                                       |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 所有 Web 页面共同结果          | `packages/animation`                                                                                 | frame、LoAF、Long Task、Event Timing、interaction、coverage；不依赖框架                                    |
| 原生 DOM/Web Components 目标   | `packages/animation`                                                                                 | Picker、CSS/WAAPI、几何/连接/Canvas backing pixels；原生是一等实现，不是失败 fallback                      |
| 页面级共享采集运行时           | `packages/browser-utils`                                                                             | 一个 rAF clock、每种 entry 一个 PerformanceObserver、共享 Web Vitals、visibility/BFCache 生命周期          |
| React / Next                   | 当前 core Profiler/manual helper；后续 `packages/animation-react`                                    | helper 采 render/base-render；commit duration 仅接独立实测，后续 adapter 再补 owner/why-update/hydration   |
| Vue / Angular / Svelte / Solid | 后续各自 `packages/animation-*`                                                                      | 使用公开 dev/performance hook 或显式 marks，不修改框架私有对象                                             |
| GSAP / Lenis / ScrollTrigger   | 当前 core GSAP/ScrollTrigger inventory helper；后续 `packages/animation-gsap`                        | 由宿主传入实例，使用 public API；后续补 Lenis/ticker、自动 checkpoint 和等价循环 analyzer，不重复捆绑 GSAP |
| Three / R3F / WebGL / WebGPU   | 当前 core Three counter helper；后续 `packages/animation-renderer`                                   | 已读 renderer.info/context loss；后续补 DPR/targets/真实 async timer query/upload/readback/dispose         |
| Canvas / media                 | 当前 Canvas direct + Video RVFC helper；后续 `packages/animation-canvas`、`packages/animation-media` | 已有 backing geometry/RVFC/drop delta；后续补 readback/decode/upload/first-visible/visibility              |
| Chrome F12 UI                  | 后续 `apps/frontend/animation-devtools-extension`                                                    | 只消费 collector/schema，不再实现一套指标                                                                  |
| Electron / 浏览器 WebView      | `packages/animation` + 后续 host bridge                                                              | 标准浏览器信号按 capability 降级；宿主生命周期和设备信息由 bridge 补充                                     |
| React Native                   | 后续 `packages/animation-react-native`                                                               | JS/UI thread frame、navigation、native driver 由 iOS/Android bridge 映射到同一 family                      |
| 小程序                         | 后续 `packages/animation-miniapp`                                                                    | 每个平台单独 adapter；不能把不存在的 PerformanceObserver 伪装为 0                                          |
| 原生 iOS/Android/Flutter       | 独立平台 SDK，再复用 RUM wire contract                                                               | 不属于浏览器子包；需要平台 frame/jank、主线程、GPU 和 lifecycle API                                        |

这些 adapter 只补框架 ownership 和渲染器内部信号。frame p95、INP、Long Task 等用户结果不会因为 React 或 Vue 而换一套定义；React commit 次数也不能与 Vue update 次数或 Three draw calls 直接横向评分。

当前目标合同把运行时拆成四个可多值轴：`uiFrameworks`、`metaRuntimes`、`renderers`、`motionEngines`。因此 React + Next + Three + GSAP 可以同时出现；原生页面明确为 `uiFrameworks:['vanilla']`，renderer 为 DOM/SVG/Canvas，而不是 `unknown`。没有 framework adapter 时只缺 owner/commit，不影响浏览器与原生目标证据。

## React Scan 借鉴边界

React Scan 提供了“一行启用、record/pause、低噪声 toolbar、按影响排序、owner/source、why-update、本地优先，以及 inspect-off→inspecting→focused 元素选择状态机”等可参考的产品体验。当前实际落地的是“一行启用 + 右下角折叠入口 + Shadow DOM + 本地即时建议 + 工具自身交互排除 + 一次性准星 Picker + Target 工作区”；收起只暂停面板重绘，不混同为停止采集。Picker 只在 active 状态安装监听器，用全页选择玻璃防止目标控件收到选择 click，Escape 清理，选中后通过标准 DOM sidecar 工作。Target 不自动录制，使用独立 Start/Stop/Reset/Clear 管理有界相关窗口；页面 collector 仍持续运行。core 已提供 React Profiler `actualDuration` 的显式 render evidence helper，但独立 page record/pause、React why-update、组件 owner 和真实 commit duration 仍留给后续 React adapter。

不把 React DevTools 私有 hook、render 次数或持续 DOM outline 作为通用核心，也不让 React adapter 解释 CSS、Canvas 或 GPU 总成本。这样非 React 页面、移动浏览器和自动化 runner 仍能使用相同结果指标。

## Codegrid 语料怎样影响设计

设计依据的本地 Codegrid 导出共解析 9,536 条 2023-01-10 至 2026-08-21 的带时间消息，最近六年窗口覆盖 100%；`unzip/` 的 249 个案例都有可读源码。所有文件均被清点，语义扫描只读取合格的抽取文本/源码；ZIP 副本、媒体、模型、依赖、generated/minified 输出没有被伪称为源码阅读。

语料反复组合 GSAP/ScrollTrigger/Lenis、React/Next、Three/WebGL/shader、Canvas、SVG、media、连续输入和移动端兼容，因此它决定了上面的 adapter 与默认测试场景。关键词数量和静态 cleanup/DPR/layout 命中只是重叠的 review candidate，不是采用率、线上问题数或优先级；是否修改仍必须由同一路由、同一语义交互的运行时证据确认。

真实站点示例放在 `examples/animation-fixtures`。当前保留三个已获再分发授权、互相补充的项目：Lemon Bureau 覆盖原生 Vite + Three/WebGL/Canvas，Nico Palmer 覆盖 React 19 + Framer Motion + GSAP/Lenis，Salle Blanche 覆盖 Next 16 + React 19 + GSAP/Lenis/View Transition。每个项目只直接依赖 Browser SDK，并在项目本来就有的浏览器入口调用一次 `@condev-monitor/monitor-sdk-browser/animation` 的 `init()`；基础示例不接入 React、GSAP、Three、WebGL 或 WebGPU 深层 probe，也不改业务组件树。

Lemon Bureau 在五个页面共用的 `js/lenis-scroll.js` 初始化，Nico Palmer 在 `src/main.jsx` 初始化，Salle Blanche 使用 Next.js 官方的 `src/instrumentation-client.js`。开发模式默认只在本地显示动画面板；只有调用方显式提供公开 DSN 时才启用动画 RUM。示例不包含 `.env`、私有上游缓存、生成报告、注入 harness 或专用 runner，验证以 SDK 导出检查、三个项目的 production build 和人工浏览器 smoke test 为准。

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

本轮已经补上其中的基础证据合同：target direct 的 Canvas 分轴尺寸/resize；连续交互的 input-to-visual、sample age、coalesced、progress/alignment、settle/overshoot 和 controller conflict；五类 page-level host evidence sink，以及 framework commit、Three counter、GSAP lifecycle、Video RVFC helper。Three/GSAP/Video helper 可以从显式传入的宿主实例读取 public evidence，但它们仍不自动发现 framework owner、不执行真实 GPU query、不做 heap/post-GC 泄漏判定，也不接管业务 cleanup。

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

本轮新增的 `captureSufficiency`、visible/hidden/other duration、document-lifetime `webVitals` latest、capture-window `resourceTiming`、interaction quality、`hostEvidence`、Target、renderer evidence 和 Canvas 分轴几何等详细结构只存在本地 `AnimationSnapshot`/Target snapshot。线上 `animation_rum` v1 仍由 SDK 按固定 13 个 capability、12 个 coverage family 和闭集 metric 列表逐项重建；不会 spread 本地快照，也不包含这些详细结构。对应闭集必须由 SDK、DSN、Worker 与存储同步维护，未知 key 会在传输前被丢弃或在信任边界被拒绝。共享 Web Vitals runtime 中的旧通用 Metrics 上传仍是另一条既有 `performance` 事件路径，不能把它误写成 animation RUM；animation 的 Resource DTO 也在共享分发前去除 name/URL。

目标隐私同样分本地与上报，但不能混用合同：

- 已实现的 `local target` 默认只在页面内存展示；可以显示有界 tag/标准 role、调用方 adapter 的 owner label/source candidate 和关键帧属性名，但不读取 id/class/text/input value/props/state/URL/像素/shader source，也不写 localStorage；
- interaction quality 只接受闭集有界数值，忽略任意额外字段，不接收 pointer 坐标轨迹、输入值、selector、owner 名、场景名或自定义 payload；
- 已实现的生产上传仍是 page-level `animation_rum` v1，必须显式 `rum.enabled`、采样命中并通过严格 allowlist；Target 详情完全不进入 v1；
- `target aggregate RUM` 需要新版本：显式 opt-in、调用方提供脱敏 `targetKey`、只发闭集数值/bucket/capability/coverage，不发本地 descriptor/source/raw sample。哈希低熵 selector 也不等于匿名，不能由 SDK 自动生成；
- 当前 integration 只有 page 一次性 `emitted`，ClickHouse v1 主键也没有 scope/window identity。同一 captureId 直接混发 target 会覆盖或被 DSN/Worker 精确 tuple 拒绝。因此 v2 必须同步修改 SDK、DSN、Worker、ClickHouse ORDER BY、Monitor API 与前端，并给目标独立 capture/window identity；本轮不会用破坏兼容的 SDK-only 改动伪装成已支持。

当前读接口只在 Monitor backend：

- `GET /api/animation/summary`：按所属应用和最长 90 天窗口返回 capture-level 聚合；
- `GET /api/animation/captures`：返回一个或多个 capture 的闭集 context、capabilities、coverage 与 metrics。

两者都要求 JWT 并在 controller 内执行 application ownership 校验。DSN server 只有受限写入口，没有只凭 `appId` 的 animation 读接口。

部署时，仓库的 `pnpm docker:deploy` / `pnpm docker:start` 会幂等重放 ClickHouse schema，因此已有 volume 也能得到 `004_animation_rum_v1.sql`。如果绕开这些脚本单独升级服务，必须先执行 `pnpm docker:init-clickhouse`，再开放 animation RUM 写入或查询。

Animation RUM 与其他监控表统一使用 `CLICKHOUSE_DATABASE` 指定的库；默认值是 `lemonade`，旧 `CLICKHOUSE_DB` 仅作为兼容回退。初始化脚本会在执行未限定库名的 schema 前校验并选择该数据库，Monitor、DSN 与 Event Worker 使用同一解析和标识符校验规则。

## 仍未实现的证据层

当前的 `not-instrumented`/`unsupported` 不是遗漏的 0。下列能力还需要单独实现和验证：

1. 完整 framework/motion adapters：React/Next owner/why-update/真实 commit、Vue/Angular/Svelte/Solid 自动更新归因，以及 GSAP/Lenis/ScrollTrigger ticker/自动 checkpoint/等价循环 analyzer；当前 core helper 只接显式 Profiler/manual/public inventory；
2. 完整 renderer/media adapters：Three/R3F/Canvas2D/WebGL/WebGPU 的 pass/target/upload/readback/context/device 数据，以及 decode/upload/first-visible/visibility；当前 core helper 只覆盖 Three public counters/context 状态与 Video RVFC/playback-quality delta；
3. 真实 GPU query：异步、稀疏、非重叠的 WebGL timer query 或 WebGPU timestamp query，并验证 availability、disjoint、context/device lost 和探针开销；当前 SDK 只做 fail-closed 合同校验；
4. CDP/trace 深层归因：首版 Labs 已有有界 JS、style/layout、paint/composite、raster/GPU 类别时间线与脱敏生成源码栈；仍缺 source map 到 authored source、逐帧 layer/CPU profile 专门视图和跨浏览器等价实现。浏览器 SDK 的 LoAF tail 不能替代这些阶段；
5. resource/media/lifecycle 深层证据：resource-to-first-visible、media decode/upload/first-visible、route/unmount 前后 listener/observer/ticker/resource/heap delta、hidden/offscreen work，以及代表设备至少十分钟 soak/post-GC plateau；
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
