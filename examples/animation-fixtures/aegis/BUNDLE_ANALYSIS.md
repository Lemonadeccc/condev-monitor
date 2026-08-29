# AEGIS 原始 Bundle 动画与依赖拆解

分析对象：

- `../aegis-experiment.vercel.app/assets/index-Cf31bgB2.js`
- `../aegis-experiment.vercel.app/assets/index-C9rc47o2.css`
- `../aegis-experiment.vercel.app/assets/antenna-BhiT2yrk.glb`

原始目录只有构建产物，没有 source map、`package.json` 或 lockfile。因此下面把结论分成三类：

- **确定**：Bundle 中存在版本号、实现代码或资源引用。
- **高置信度**：库名被压缩掉了，但 API 结构和实现特征可以唯一或近似唯一地识别。
- **After 适配**：为了让副本更容易运行而做的兼容处理，不声称与原版源码逐字一致。

## 1. 能从 Bundle 确认哪些依赖

| 依赖/能力 | 结论 | 证据与说明 |
| --- | --- | --- |
| React | **19.2.6，确定** | Bundle 内保留 `version="19.2.6"`。 |
| React DOM | **19.2.6，确定** | 与 React 运行时代码一同打包，版本签名一致。 |
| Three.js | **r184 / 0.184.0，确定** | Bundle 内有 `const ...="184"`，并作为 `REVISION` 导出。 |
| `@react-three/fiber` | **9.6.1，确定** | Bundle 内保留 `{version:"9.6.1"}`。 |
| `@react-three/drei` | **使用了，版本未知，高置信度** | 能识别出 `ScrollControls`、滚动 context 和 GLTF 缓存加载；Drei 的包版本没有保留。 |
| GSAP | **3.15.0，确定** | GSAP core 和插件代码均保留 `version="3.15.0"`。 |
| GSAP ScrambleText | **使用了，确定** | Bundle 中有 `name:"scrambleText"`、字符集和 `scrambleText` tween 调用。 |
| GSAP SplitText | **使用了，确定** | 可看到把元素拆成 `chars` 并逐字符创建 timeline 的调用。 |
| `@gsap/react` | **很可能使用，高置信度** | 存在 React effect/context 封装后的 GSAP 生命周期调用；具体包版本没有留在产物中。 |
| `lil-gui` | **使用了，确定** | 完整 GUI/controller 代码进入 Bundle，场景调参面板默认隐藏。版本号未保留。 |
| Tailwind CSS | **v4 系列，高置信度** | CSS 中保留 `@layer theme/base/utilities`、`@property --tw-*` 和 v4 风格工具类产物；精确小版本没有保留。 |
| `@fontsource/ibm-plex-mono` | **很可能使用，高置信度** | 多语种切片文件名与 `unicode-range` 结构符合 Fontsource 的构建产物；页面实际只需现有 Latin 字体资源。 |
| Vite | **很可能使用，高置信度** | `index-[hash].js/css`、资源 URL 重写和单页 HTML 结构符合 Vite 生产产物。版本未知。 |
| WebGPU | **Three.js 内建能力，不是额外渲染库** | 原版创建 Three `WebGPURenderer`；不支持时显示错误文本。 |
| TSL / Node Material | **Three.js 内建能力** | 材质和后处理由 `three/tsl` 节点图生成 WGSL，而不是手写一份独立 shader 文件。 |

注意：生产 Bundle 能证明“什么代码被打进来了”，但不能完整还原原始 `dependencies` 与 `devDependencies` 的边界。例如 Drei 的多个 helper 会被 tree-shake 到同一个文件里，包名和版本通常不会留下。

`after/package.json` 因此采用以下策略：

- 对 Bundle 中能读到的版本使用精确版本：React `19.2.6`、R3F `9.6.1`、Three `0.184.0`、GSAP `3.15.0`。
- 对能确定使用、但版本已丢失的库，选择与上述核心版本兼容的版本。
- 保留现有项目的 Next.js 外壳；原版更像 Vite，但重写整个应用构建系统对动画还原没有收益。

## 2. 模型是怎么导入的

原始模型 URL 是：

```text
/assets/antenna-BhiT2yrk.glb
```

对 GLB 的 JSON chunk 直接检查后可以确认：

| 内容 | 数量 |
| --- | ---: |
| Scene | 1 |
| Node | 1 |
| Mesh | 1 |
| Primitive | 1 |
| Material | 0 |
| Texture / Image | 0 |
| Animation | 0 |
| Skin | 0 |
| Camera | 0 |
| 压缩扩展 | 0 |

节点名为 `Rooftop Antenna.001`，文件由 Blender glTF exporter 生成。也就是说：

1. GLB 只负责几何体，不携带最终视觉材质。
2. 页面运行时加载模型后，遍历 mesh 并替换为自定义 Node Material。
3. 没有骨骼动画、关键帧动画或贴图序列；“模型被扫描出来”的效果全部来自 shader uniform 与滚动进度。

After 中对应实现位于：

- `components/scene/AntennaModel.jsx`
- 使用 Drei `useGLTF()` 负责加载、缓存和 Suspense。
- `useGLTF.preload()` 提前触发模型请求。
- 用 `Box3` 计算模型的实际 Y 边界，避免把 reveal 参数写死到某个模型高度。

## 3. 扫描材质怎么做

模型材质是 `MeshStandardNodeMaterial`，所以仍然走 PBR 光照，并保留粗糙度、金属度和阴影能力，只是 `colorNode` 与 `emissiveNode` 改为 TSL 节点图。Bundle 给模型 mesh 设置了 `castShadow=true`、给地形设置了 `receiveShadow=true`，但没有给方向光显式设置 `castShadow=true`；因此原始成品实际上未必生成动态 shadow map，这里没有擅自“补亮”一套原版不存在的阴影。

核心过程可以写成：

```text
height01 = (worldPosition.y - boundsMinY) / boundsHeight
noise    = mx_noise_float(localPosition * noiseScale + timeOffset)
front    = progress * 1.3 - 0.15
distance = front - (height01 + noise * noiseAmount)

revealed = smoothstep(0.0, 0.01, distance)
edge     = smoothstep(edgeWidth, 0.0, abs(distance))
ghost    = 1.0 - revealed
```

然后把三个视觉层合起来：

1. **实体层**：`bodyColor * revealed`。扫描线经过后出现紫黑色实体。
2. **扫描边缘**：`edgeColor * edge`，同时进入 emissive，所以会被 bloom 放大成橙红色光带。
3. **未扫描幽灵层**：用 view-space 法线与视线方向计算 Fresnel rim，再叠加 local-space 抗锯齿网格；它只出现在 `ghost` 区域。

关键默认值：

| 参数 | 值 |
| --- | ---: |
| Edge width | `0.053` |
| Noise scale | `1.56` |
| Noise speed | `0.05` |
| Noise amount | `0.19` |
| Edge emissive/bloom input | `4` |
| Base opacity | `0.5` |
| Rim strength | `2.88` |
| Rim power | `8` |
| Grid scale | `4` |
| Grid width | `0.021` |

滚动不会替换模型，也不会播放 GLB animation。每帧只是把 `useScroll().offset` 映射到 `progress` uniform。

## 4. 滚轮为什么能驱动镜头

原版使用 Drei `ScrollControls`：

```jsx
<ScrollControls pages={5} damping={0.25}>
  <Scene />
</ScrollControls>
```

它在 Canvas 上方维护自己的滚动容器，并把实际 scrollTop 阻尼成归一化的 `offset ∈ [0, 1]`。因此：

- `pages={5}` 代表约五屏滚动距离，不是五个独立 HTML 页面。
- `damping={0.25}` 使滚轮输入与镜头状态之间有惯性。
- 场景在 `useFrame()` 中读取 `offset`，因此 3D 镜头不依赖 React 每帧 setState。
- GSAP 没有负责 3D 相机轨迹；GSAP 主要负责 HUD、文字闪烁、scramble、loader 和弹层。

### 镜头不是样条，而是三段参数函数

基础角度：

```text
angle = π * 0.25 + progress * 1.15 * 2π
x = sin(angle) * radius
z = cos(angle) * radius
camera.lookAt(0, targetY, 0)
```

所以镜头围绕天线旋转约 `1.15` 圈。半径、高度和 lookAt 高度分段插值：

| 进度 | radius | camera Y | target Y | 视觉含义 |
| --- | --- | --- | --- | --- |
| `0 → 0.55` | `6 → 4.4` | `0.5 → 10` | `4.8 → 11.5` | 贴近塔体向上环绕 |
| `0.55 → 0.85` | `4.4 → 210` | `10 → 30` | `11.5 → 10` | 快速拉远，展示地形与能量柱 |
| `0.85 → 1` | `210 → 130` | `30 → 85` | `10 → 4` | 抬高并进入最终城市级远景 |

其他修正：

- 开场有 `-3.5` 的侧向偏移，进度 `0 → 0.22` 时被吸收。
- 末段从 `0.85` 开始加入 `-90` 的右向量偏移，制造非对称构图。
- 中段有约 `-0.045 rad` 的 roll。
- 末段有 `-0.05` 的缓慢水平漂移。
- 移动端调整近景半径，并把最终半径改为 `170`、侧移改为 `-60`。
- 原版还有鼠标视差：强度 `0.1`、阻尼 `3`，镜头拉远阶段会把强度临时压到 `0.1` 倍。
- loader 开始淡出后，镜头用 `1.8s` 的 cubic ease 从独立 intro camera 混合到滚动轨迹。
- After 只在用户开启 reduced motion 时停止视差和装饰漂移，这是可访问性兼容差异。

所有关键点都集中在 `lib/sceneConfig.js`，轨迹计算在 `components/scene/CameraRig.jsx`。这里的“点”不是一串 `Vector3` 控制点，而是三个进度区间的端点参数，再经过 `smoothstep` 插值。

## 5. 其他 WebGL / WebGPU 效果怎么拆

### 地形

地形不是矩形平面，而是一圈围绕天线的径向山脉：

```text
angular segments = 260
radial segments  = 72
inner radius     = 14
outer radius     = 112

height = ridgedFbm(x * 0.016, z * 0.016)
       * 17 * (0.18 + 4 * radialProgress^1.6)
       * innerOuterFade

color = contrastMix(valley, mid, crest, normalizedHeight)
emissive = crestColor * crestMask
```

同一份 geometry 再绘制一次 wireframe。loader 淡出后延迟 `1s`，再用 `1.25s` ease-out 逐渐放出山体网格；网格透明度还有 `sin(time * 1.2)` 脉冲。

### 反射扫描网格

原版还有一张 `400 × 400` 的地面平面，上一版 After 完全遗漏：

- Three TSL `reflector({ resolutionScale: 1, depth: true, bounces: false })`。
- 45 次径向采样形成带 depth 权重的模糊反射。
- 十字、方格、沿 Z 方向移动的扫描波由 TSL 生成。
- 反射相机关闭粒子所在的 layer 1，因此粒子不会进入地面反射。
- 地面反射强度默认 `2`，远处在半径 `90 → 190` 之间淡出。

### 空间粒子

- 2,500 个随机初始位置。
- 使用 `SpriteNodeMaterial` 和 `instanceIndex`，不是 `PointsMaterial`。
- 每个 sprite 面向相机，尺寸在 `0.03 → 0.1` 之间。
- Y 坐标持续上移并用 `mod` 回卷；X 坐标做轻微正弦摆动。
- 颜色在白色与红色之间缓慢变化，emissive 为 `5.5`，透明度最大约 `0.2`。

### 地面脉冲

- 一张半径 `26`、96 段的 `CircleGeometry`。
- shader 根据 `length(localPosition.xy)` 生成单个向外运动的窄环。
- 速度 `0.25`、宽度 `0.9`，使用 additive blending。
- 滚动进度只控制整体 intensity。

### 能量柱

- 从 Y=`1` 到 Y=`130` 的固定开放 cylinder。
- geometry 本身不缩放；shader 用 local Y 与 `tip` uniform 决定哪些片元可见。
- tip 附近叠加窄发光带，柱体内部还有沿 Y 方向移动的正弦明暗。
- `0.55 → 0.72` 完成主要点火，`0.72` 附近短暂增强发光。

### 最终部署球

- 从 Icosahedron 面细分生成球面单元，再围绕每个顶点构造多边形 triangle fan。
- frequency 为 `36`，基础 radius 为 `23`，mesh scale 为 `5`，实际视觉半径约 `115`。
- geometry 带 `aEdge`、`aCellRandom`、`aCellY` 三个自定义 attribute。
- 使用独立 `MeshStandardNodeMaterial` 生成六边形边缘、cell reveal、energy noise 和 ghost rim。
- `0.74 → 1` 把 reveal uniform 从 `0 → 0.5`；原版没有让球体持续自转。

### 空间文字

- 不是 Drei `Html`。
- 每组文字先绘制到 `CanvasTexture`，字体为 100px IBM Plex Mono。
- texture 放进 `MeshBasicNodeMaterial` 平面，`toneMapped=false`。
- 滚动进入时从左向右裁切，离开时继续从左侧擦除。
- 平面按相机轨迹中点放在半径 `3` 的塔体周围。

## 6. 后处理链怎么做

原版不是传统 `EffectComposer + ShaderPass`，而是 Three WebGPU 的 `RenderPipeline` 和 TSL display nodes：

```text
scene pass
  → 5-mip bloom
  → custom radial chromatic aberration
  → custom vignette
  → custom stepped grain
  → screen
```

After 对应 `components/scene/NodePostProcessing.jsx`：

| 效果 | 默认值 | 作用 |
| --- | ---: | --- |
| Bloom strength | `0.33` | 放大扫描边缘、山脊和 beam 的 emissive |
| Bloom radius | `0.5` | 控制多级模糊扩散 |
| Bloom threshold | `0` | 几乎所有正亮度 emissive 都可进入 bloom |
| Chromatic strength | `0.008` | 按 `centerOffset × radius × strength` 偏移红/蓝采样 |
| Vignette smoothing | `0.27` | 压暗画面边缘 |
| Vignette exponent | `1.5` | 控制暗角曲线 |
| Grain intensity | `0.004` | 极轻胶片颗粒 |
| Grain scale | `1.5` | 颗粒空间频率 |
| Grain FPS | `12` | 对时间取整，让噪点有离散跳动感 |

WebGPU 下，TSL 节点图会由 Three 生成 WGSL。After 还提供 `forceWebGL` 兼容路径；Three 会把同一节点图编译到 WebGL 2。这是有意添加的兼容性差异，因为原 Bundle 在浏览器没有 WebGPU 时会直接显示“不支持”。

## 7. DOM 动画怎么做

GSAP 负责的是 2D UI，不是场景相机：

- ScrambleText：按钮 hover、滚动提示和 rail 标签；loader 状态文字本身不 scramble。
- SplitText：把标题拆成字符，逐字符做 `0 → 1 → 0.12 → 1` 的闪烁。
- GSAP timeline：loader 收缩/淡出、contact overlay 进入/退出。
- `gsap.ticker`：读取共享 scroll offset，并直接更新 HUD opacity/transform，避免每帧触发 React render。

Bundle 中出现的 `ScrollTrigger` 字样来自 GSAP core 对可选插件的兼容入口，没有看到 ScrollTrigger 被注册或用于相机。因此 After 没有把 ScrollTrigger 加进依赖。

## 8. 调参点是怎么定义的

原版把一组普通对象交给 `lil-gui`。After 同样集中维护可变配置：

- `CAMERA_PATH`
- `FINAL_CAMERA`
- `ANTENNA_CONFIG`
- `POST_CONFIG`
- `TERRAIN_CONFIG`

页面加载后按 `G` 显示隐藏的 GUI。改变值后，每帧把配置同步到 TSL uniform 或相机函数，因此无需重新创建材质和几何体。

## 9. 本轮 Bundle 差异审计

| 上一版 `after/` | Bundle 原版 / 当前修正 |
| --- | --- |
| 矩形山体平面 | 14→112 半径的径向环形山体 |
| 没有反射地网 | 400×400 reflector + depth blur + scan grid |
| `PointsMaterial` 粒子 | instanced `SpriteNodeMaterial` |
| 四个 Torus 脉冲 | 单个 CircleGeometry shader 波 |
| 缩放 cylinder | 固定 cylinder 内部按 local Y reveal |
| 普通 wireframe sphere，radius 23 | frequency 36 的 cell sphere，最终 scale 5 |
| Drei HTML 标签 | CanvasTexture 3D 平面裁切 |
| 现成色差/FilmNode，色差值额外乘 50 | Bundle 中的自写 TSL 色差、暗角和 grain |
| 镜头侧移右向量方向相反 | `(-forward.z, forward.x)` |
| 模型额外自转，roughness `0.45` / metalness `0.5` | 模型不自转，NodeMaterial 使用默认 `1 / 0` |
| fog 随整段滚动线性变淡 | 第一次滚动后按 `1.2s` intro timeline 变淡 |
| HUD 在 loader 后常驻并线性跟随 opacity | Bundle 的 GSAP threshold timeline、字符 flicker 与 idle flicker |
| 主场景上覆盖 CSS 横向扫描线 | 主 HUD 无扫描线覆盖；只有 contact 弹层使用 `mix-blend-mode: overlay` 扫描线 |
| 按钮整体 `clip-path` + 伪元素边框 | 裁切的点阵/扫描底板与独立 SVG 斜角边框分层绘制 |

## 10. After 与当前根目录实现的主要差别

| 当前根目录 | `after/` |
| --- | --- |
| 原生 Three WebGL 场景 | R3F 场景声明与组件化生命周期 |
| window/document 滚动驱动 | Drei `ScrollControls + useScroll` |
| 常规 WebGL material | Three TSL `MeshStandardNodeMaterial` |
| 常规 renderer | WebGPU-first `WebGPURenderer` |
| 手工或有限后处理 | TSL `RenderPipeline` 完整效果链 |
| CSS 为主的 HUD 动画 | GSAP ScrambleText、SplitText 和 timeline |
| 参数散落在场景逻辑 | `sceneConfig.js + lil-gui` 集中调试 |

这不是对 minified Bundle 的反编译源码复原，而是以可读组件重新表达 Bundle 中可以确认的运行时架构、参数和视觉机制。
