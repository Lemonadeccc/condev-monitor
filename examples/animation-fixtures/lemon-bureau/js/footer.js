// footer.js — fluid-master simulation + custom 2D canvas drawing (no p5)

const CFG = {
  // === Particle count controls ===
  // mode:
  // - "fluid-master": derive count from grid density + spawn volume (like the demo)
  // - "fixed": use `targetParticles` exactly
  particleCountMode: "fixed",
  targetParticles: 1500,
  // hard upper cap to protect performance
  maxParticles: 3000,
  // GPU particle texture width; fluid-master uses 512
  particlesTextureWidth: 512,

  particleSize: 7.5,
  alphaBase: 1000,
  darkenDens: 6,

  // fluid-master world dimensions
  gridWidth: 40,
  gridHeight: 20,
  gridDepth: 10,
  particlesPerCell: 0.1,

  // spawn volume (fluid-master "dam break" preset)
  // [0,0,0] to [15,20,20]
  spawnAabbMin: [0, 0, 0],
  spawnAabbMax: [15, 20, 20],

  flipness: 0.5,
  timeStep: 1 / 60,

  // fluid-master default slider value
  gridCellDensity: 0.35,

  // === Mouse / force controls ===
  mouseEnabled: true,
  // scales the mouse velocity vector before passing into the shader
  mouseForce: 1.0,
  // extra gain on mouse movement before converting to world units/sec
  mouseVelGain: 0.5,
  // clamp in world units/sec to avoid explosions
  mouseVelMax: 5,
  // smooth mouse velocity to reduce jitter (0 = no smoothing)
  mouseSmoothing: 0.25,
  // only apply when hovered
  mouseOnlyOnHover: true,

  // === Particle separation (prevents clumping) ===
  separationEnabled: true,
  // minimum distance in world units (try 0.35–0.8 depending on density)
  separationMinDist: 0.55,
  // how strongly to push apart per iteration (0..1)
  separationStrength: 0.55,
  // iterations of relaxation per frame
  separationIters: 2,
};

(function () {
  const rs = getComputedStyle(document.documentElement);
  const BG = rs.getPropertyValue("--d").trim() || "#0f0f0f";
  const FG = rs.getPropertyValue("--l").trim() || "#ffd601";
  const _h = FG.replace("#", "");
  const [FR, FGc, FB] = [0, 2, 4].map((i) => parseInt(_h.slice(i, i + 2), 16));

  const mount = document.getElementById("footer-canvas");
  if (!mount) return;

  let CW = 1,
    CH = 1;
  let hover = false;

  // Pause/defers the heavy footer fluid simulation when the footer isn't
  // near the viewport. This keeps the rest of the page (scrolling + other
  // animations) responsive.
  let active = false;
  let started = false;
  let rafId = null;

  const footerEl = mount.closest("footer") || document.querySelector("footer");
  let readState = null;

  // Separation buffers to avoid per-frame Map/string allocations.
  let sepCellSize = 0;
  let sepNx = 0;
  let sepNy = 0;
  let sepCounts = null; // Int32Array (cells -> particle count)
  let sepOffsets = null; // Int32Array (prefix sums, size cells+1)
  let sepIndices = null; // Int32Array (particles grouped by cell, stable order)
  let sepWritePos = null; // Int32Array (scratch write cursor per cell)
  let sepSeen = null; // Uint8Array (cells seen in this iter, for cell-order)
  let sepCellOrder = null; // Int32Array (occupied cell indices in insertion order)

  // Reused per-frame vectors to avoid allocations.
  const mouseVelocity = new Float32Array(3);
  const mouseRayOrigin = new Float32Array(3);
  const mouseRayDirection = new Float32Array([0, 0, 1]);

  // Visible canvas (2D drawing)
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  mount.appendChild(canvas);
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return;

  // Cache per-particle draw resources to reduce per-frame allocation work.
  const colorCache = new Map();
  const particleSize = CFG.particleSize;
  const halfParticleSize = particleSize / 2;
  const particleAlpha = CFG.alphaBase / 255;
  const circlePath = new Path2D();
  circlePath.arc(0, 0, halfParticleSize, 0, Math.PI * 2);
  const trianglePath = new Path2D();
  trianglePath.moveTo(-halfParticleSize, halfParticleSize);
  trianglePath.lineTo(halfParticleSize, halfParticleSize);
  trianglePath.lineTo(0, -halfParticleSize);
  trianglePath.closePath();

  // GPU sim canvas (offscreen)
  let simCanvas = null;
  let wgl = null;
  let simulator = null;
  let simReady = false;

  // Readback buffers
  let N = 0;
  let particlesWidth = 0;
  let particlesHeight = 0;
  let positionPixels = null; // Float32Array RGBA
  let lastPosX = null;
  let lastPosY = null;
  let rotArr = null;
  let rotVArr = null;
  let shpArr = null;
  let densArr = null;

  // Mouse state
  let mouseX = 0;
  let mouseY = 0;
  let mousePrevX = 0;
  let mousePrevY = 0;
  let mouseVelSmoothX = 0;
  let mouseVelSmoothY = 0;

  // Reusable buffer for uploading corrected positions back to GPU.
  let uploadPositionsData = null; // Float32Array (particlesWidth*particlesHeight*4)

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function computeSimParticleCountAndTextureDims() {
    // Decide desired count
    let desired = 0;
    if (CFG.particleCountMode === "fixed") {
      desired = Math.max(1, CFG.targetParticles | 0);
    } else {
      const { gridResolutionX, gridResolutionY, gridResolutionZ } =
        computeFluidMasterResolutions();
      const totalGridCells =
        gridResolutionX * gridResolutionY * gridResolutionZ;
      desired = computeDesiredParticleCount(totalGridCells);
    }

    desired = Math.min(desired, Math.max(1, CFG.maxParticles | 0));

    const w = Math.max(4, CFG.particlesTextureWidth | 0);
    const h = Math.max(1, Math.ceil(desired / w));
    return { desired, w, h };
  }

  function computeFluidMasterResolutions() {
    const GRID_WIDTH = CFG.gridWidth;
    const GRID_HEIGHT = CFG.gridHeight;
    const GRID_DEPTH = CFG.gridDepth;
    const gridCells =
      GRID_WIDTH * GRID_HEIGHT * GRID_DEPTH * CFG.gridCellDensity;

    // assuming x:y:z ratio of 2:1:1 (fluid-master)
    const gridResolutionY = Math.ceil(Math.pow(gridCells / 2, 1.0 / 3.0));
    const gridResolutionZ = gridResolutionY * 1;
    const gridResolutionX = gridResolutionY * 2;

    return {
      gridResolutionX,
      gridResolutionY,
      gridResolutionZ,
      GRID_WIDTH,
      GRID_HEIGHT,
      GRID_DEPTH,
    };
  }

  function aabbVolume(min, max) {
    return (
      Math.max(0, max[0] - min[0]) *
      Math.max(0, max[1] - min[1]) *
      Math.max(0, max[2] - min[2])
    );
  }

  function randomPointInAabb(min, max) {
    return [
      lerp(min[0], max[0], Math.random()),
      lerp(min[1], max[1], Math.random()),
      lerp(min[2], max[2], Math.random()),
    ];
  }

  function computeDesiredParticleCount(totalGridCells) {
    const totalVolume = CFG.gridWidth * CFG.gridHeight * CFG.gridDepth;
    const fillVolume = aabbVolume(CFG.spawnAabbMin, CFG.spawnAabbMax);
    const fractionFilled = clamp(
      fillVolume / Math.max(1e-6, totalVolume),
      0,
      1,
    );
    return Math.floor(fractionFilled * totalGridCells * CFG.particlesPerCell);
  }

  function buildInitialParticlePositions() {
    const positions = new Array(particlesWidth * particlesHeight);
    for (let i = 0; i < N; i++) {
      positions[i] = randomPointInAabb(CFG.spawnAabbMin, CFG.spawnAabbMax);
    }
    // Padding particles (not drawn)
    for (let i = N; i < particlesWidth * particlesHeight; i++) {
      positions[i] = [
        Math.random() * CFG.gridWidth,
        Math.random() * CFG.gridHeight,
        Math.random() * CFG.gridDepth,
      ];
    }
    return positions;
  }

  function initCpuDrawState() {
    const { desired, w, h } = computeSimParticleCountAndTextureDims();
    particlesWidth = w;
    particlesHeight = h;
    N = desired;

    positionPixels = new Float32Array(particlesWidth * particlesHeight * 4);
    lastPosX = new Float32Array(N);
    lastPosY = new Float32Array(N);
    rotArr = new Float32Array(N);
    rotVArr = new Float32Array(N);
    densArr = new Float32Array(N);
    shpArr = new Uint8Array(N);

    for (let i = 0; i < N; i++) {
      rotArr[i] = Math.random() * Math.PI * 2;
      rotVArr[i] = (Math.random() - 0.5) * 0.15;
      shpArr[i] = i % 3;
      densArr[i] = 0;
    }

    // Precompute CPU separation acceleration grid.
    initSeparationBuffers();
  }

  function initSeparationBuffers() {
    sepCellSize = Math.max(1e-4, CFG.separationMinDist);
    sepNx = Math.max(1, Math.ceil(CFG.gridWidth / sepCellSize));
    sepNy = Math.max(1, Math.ceil(CFG.gridHeight / sepCellSize));

    const cellCount = sepNx * sepNy;

    // Counting sort workspaces (stable within each cell, matching original
    // particle insertion order).
    sepCounts = new Int32Array(cellCount);
    sepOffsets = new Int32Array(cellCount + 1);
    sepIndices = new Int32Array(N);
    sepWritePos = new Int32Array(cellCount);
    sepSeen = new Uint8Array(cellCount);
    sepCellOrder = new Int32Array(cellCount);
  }

  function initGpuSim(onReady) {
    simReady = false;

    simCanvas = document.createElement("canvas");
    simCanvas.width = Math.max(1, Math.floor(CW));
    simCanvas.height = Math.max(1, Math.floor(CH));

    wgl = new WrappedGL(simCanvas, {
      alpha: false,
      antialias: false,
      premultipliedAlpha: false,
    });
    wgl.getExtension("OES_texture_float");
    wgl.getExtension("OES_texture_float_linear");
    wgl.getExtension("WEBGL_color_buffer_float");
    wgl.getExtension("OES_texture_half_float");
    wgl.getExtension("OES_texture_half_float_linear");

    // Reuse the same readback state object every frame (avoid allocations).
    readState = wgl.createReadState();

    simulator = new Simulator(wgl, () => {
      simulator.flipness = CFG.flipness;

      const {
        gridResolutionX,
        gridResolutionY,
        gridResolutionZ,
        GRID_WIDTH,
        GRID_HEIGHT,
        GRID_DEPTH,
      } = computeFluidMasterResolutions();
      const gridSize = [GRID_WIDTH, GRID_HEIGHT, GRID_DEPTH];
      const gridResolution = [
        gridResolutionX,
        gridResolutionY,
        gridResolutionZ,
      ];

      const particlePositions = buildInitialParticlePositions();
      simulator.reset(
        particlesWidth,
        particlesHeight,
        particlePositions,
        gridSize,
        gridResolution,
        CFG.particlesPerCell,
      );

      simReady = true;
      onReady?.();
    });
  }

  function readBackPositions() {
    wgl.framebufferTexture2D(
      simulator.simulationFramebuffer,
      wgl.FRAMEBUFFER,
      wgl.COLOR_ATTACHMENT0,
      wgl.TEXTURE_2D,
      simulator.particlePositionTexture,
      0,
    );
    readState.bindFramebuffer(simulator.simulationFramebuffer);
    wgl.readPixels(
      readState,
      0,
      0,
      particlesWidth,
      particlesHeight,
      wgl.RGBA,
      wgl.FLOAT,
      positionPixels,
    );
  }

  function enforceSeparation() {
    if (!CFG.separationEnabled) return;
    const minDist = Math.max(1e-4, CFG.separationMinDist);
    const minDist2 = minDist * minDist;
    const strength = clamp(CFG.separationStrength, 0, 1);
    const iters = Math.max(1, CFG.separationIters | 0);

    if (
      !sepIndices ||
      sepCellSize !== minDist ||
      !sepCounts ||
      !sepOffsets
    ) {
      initSeparationBuffers();
    }

    const cell = sepCellSize;
    const clampMinX = 0.01;
    const clampMaxX = CFG.gridWidth - 0.01;
    const clampMinY = 0.01;
    const clampMaxY = CFG.gridHeight - 0.01;

    const cellCount = sepNx * sepNy;

    for (let iter = 0; iter < iters; iter++) {
      // Build a stable (ascending particle index) per-cell index list
      // using counting sort.
      sepCounts.fill(0);
      sepSeen.fill(0);

      let cellOrderLen = 0;

      // 1) Count particles per cell + capture the Map insertion order
      //    (first time each cell becomes non-empty in ascending i order).
      for (let i = 0; i < N; i++) {
        const x = positionPixels[i * 4];
        const y = positionPixels[i * 4 + 1];
        const gx = Math.floor(x / cell);
        const gy = Math.floor(y / cell);
        if (gx < 0 || gx >= sepNx || gy < 0 || gy >= sepNy) continue;
        const b = gy * sepNx + gx;

        if (sepSeen[b] === 0) {
          sepSeen[b] = 1;
          sepCellOrder[cellOrderLen++] = b;
        }
        sepCounts[b]++;
      }

      // 2) Prefix sums -> offsets into sepIndices.
      let sum = 0;
      for (let c = 0; c < cellCount; c++) {
        sepOffsets[c] = sum;
        sum += sepCounts[c];
      }
      sepOffsets[cellCount] = sum;

      // Scratch: current write position per cell.
      sepWritePos.set(sepOffsets.subarray(0, cellCount));

      // 3) Fill sepIndices in ascending i order per cell.
      for (let i = 0; i < N; i++) {
        const x = positionPixels[i * 4];
        const y = positionPixels[i * 4 + 1];
        const gx = Math.floor(x / cell);
        const gy = Math.floor(y / cell);
        if (gx < 0 || gx >= sepNx || gy < 0 || gy >= sepNy) continue;
        const b = gy * sepNx + gx;

        const pos = sepWritePos[b];
        sepIndices[pos] = i;
        sepWritePos[b] = pos + 1;
      }

      // Apply pairwise separation, iterating cells + particles in the same
      // order that the original Map-based code effectively produced.
      for (let orderIdx = 0; orderIdx < cellOrderLen; orderIdx++) {
        const cellIndex = sepCellOrder[orderIdx];
        const gx = cellIndex % sepNx;
        const gy = (cellIndex / sepNx) | 0;

        const startI = sepOffsets[cellIndex];
        const endI = sepOffsets[cellIndex + 1];

        for (let ox = -1; ox <= 1; ox++) {
          const nbx = gx + ox;
          if (nbx < 0 || nbx >= sepNx) continue;

          for (let oy = -1; oy <= 1; oy++) {
            const nby = gy + oy;
            if (nby < 0 || nby >= sepNy) continue;

            const nbCellIndex = nby * sepNx + nbx;
            if (sepCounts[nbCellIndex] === 0) continue;

            const startJ = sepOffsets[nbCellIndex];
            const endJ = sepOffsets[nbCellIndex + 1];

            for (let a = startI; a < endI; a++) {
              const i = sepIndices[a];
              const i4 = i * 4;

              for (let b = startJ; b < endJ; b++) {
                const j = sepIndices[b];
                if (j <= i) continue;

                const j4 = j * 4;

                const ix = positionPixels[i4];
                const iy = positionPixels[i4 + 1];
                const jx = positionPixels[j4];
                const jy = positionPixels[j4 + 1];

                const dx = ix - jx;
                const dy = iy - jy;
                const d2 = dx * dx + dy * dy;
                if (d2 >= minDist2 || d2 < 1e-10) continue;

                const d = Math.sqrt(d2);
                const overlap = (minDist - d) / d;
                const pushX = dx * overlap * 0.5 * strength;
                const pushY = dy * overlap * 0.5 * strength;

                positionPixels[i4] = clamp(ix + pushX, clampMinX, clampMaxX);
                positionPixels[i4 + 1] = clamp(
                  iy + pushY,
                  clampMinY,
                  clampMaxY,
                );

                positionPixels[j4] = clamp(jx - pushX, clampMinX, clampMaxX);
                positionPixels[j4 + 1] = clamp(
                  jy - pushY,
                  clampMinY,
                  clampMaxY,
                );
              }
            }
          }
        }
      }
    }
  }

  function uploadCorrectedPositionsToGPU() {
    if (
      !uploadPositionsData ||
      uploadPositionsData.length !== positionPixels.length
    ) {
      uploadPositionsData = new Float32Array(positionPixels.length);
    }
    uploadPositionsData.set(positionPixels);

    // Clamp padding particles too (avoid NaNs / out-of-bounds).
    for (let i = N; i < particlesWidth * particlesHeight; i++) {
      uploadPositionsData[i * 4] = clamp(
        uploadPositionsData[i * 4],
        0.01,
        CFG.gridWidth - 0.01,
      );
      uploadPositionsData[i * 4 + 1] = clamp(
        uploadPositionsData[i * 4 + 1],
        0.01,
        CFG.gridHeight - 0.01,
      );
      uploadPositionsData[i * 4 + 2] = clamp(
        uploadPositionsData[i * 4 + 2],
        0.01,
        CFG.gridDepth - 0.01,
      );
    }

    wgl.rebuildTexture(
      simulator.particlePositionTexture,
      wgl.RGBA,
      wgl.FLOAT,
      particlesWidth,
      particlesHeight,
      uploadPositionsData,
      wgl.CLAMP_TO_EDGE,
      wgl.CLAMP_TO_EDGE,
      wgl.NEAREST,
      wgl.NEAREST,
    );
  }

  function updateDerivedState(dt) {
    for (let i = 0; i < N; i++) {
      // world -> canvas projection (orthographic, ignore Z)
      const wx = positionPixels[i * 4];
      const wy = positionPixels[i * 4 + 1];
      const x = (wx / CFG.gridWidth) * CW;
      const y = CH - (wy / CFG.gridHeight) * CH;

      const vx = (x - lastPosX[i]) / Math.max(1e-6, dt);
      const vy = (y - lastPosY[i]) / Math.max(1e-6, dt);
      const speed = Math.sqrt(vx * vx + vy * vy);

      rotVArr[i] +=
        Math.min(0.08, speed * 0.00008) * (Math.random() < 0.5 ? 1 : -1);
      rotVArr[i] *= 0.985;
      rotArr[i] += rotVArr[i] * dt * 60;

      densArr[i] = Math.max(0, Math.min(5, densArr[i] * 0.9 + speed * 0.003));

      lastPosX[i] = x;
      lastPosY[i] = y;
    }
  }

  function draw() {
    ctx.clearRect(0, 0, CW, CH);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, CW, CH);

    for (let i = 0; i < N; i++) {
      const wx = positionPixels[i * 4];
      const wy = positionPixels[i * 4 + 1];
      const x = (wx / CFG.gridWidth) * CW;
      const y = CH - (wy / CFG.gridHeight) * CH;

      const dk = Math.min(densArr[i], 5) * CFG.darkenDens;
      const r = Math.max(0, FR - dk) | 0;
      const g = Math.max(0, FGc - dk) | 0;
      const b = Math.max(0, FB - dk) | 0;

      // Cache rgba() strings (r/g/b are small integer ranges).
      const colorKey = ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);
      let fill = colorCache.get(colorKey);
      if (!fill) {
        fill = `rgba(${r},${g},${b},${particleAlpha})`;
        colorCache.set(colorKey, fill);
      }
      ctx.fillStyle = fill;

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rotArr[i]);

      const s = shpArr[i];
      if (s === 0) {
        ctx.fill(trianglePath);
      } else if (s === 1) {
        ctx.fillRect(
          -halfParticleSize,
          -halfParticleSize,
          particleSize,
          particleSize,
        );
      } else {
        ctx.fill(circlePath);
      }
      ctx.restore();
    }
  }

  function resize() {
    const f = footerEl;
    CW = Math.max(1, f?.clientWidth || mount.clientWidth || 1);
    CH = Math.max(1, f?.clientHeight || mount.clientHeight || 1);

    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    canvas.width = Math.floor(CW * dpr);
    canvas.height = Math.floor(CH * dpr);
    canvas.style.width = CW + "px";
    canvas.style.height = CH + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    initCpuDrawState();
    initGpuSim(() => {
      readBackPositions();
      for (let i = 0; i < N; i++) {
        lastPosX[i] = positionPixels[i * 4];
        lastPosY[i] = CH - positionPixels[i * 4 + 1];
      }
    });
  }

  function ensureTick() {
    if (!active) return;
    if (rafId != null) return;
    rafId = requestAnimationFrame(tick);
  }

  function tick() {
    rafId = null;
    if (!active) return;

    if (simReady) {
      const dt = CFG.timeStep;

      const dmx = mouseX - mousePrevX;
      const dmy = mouseY - mousePrevY;

      // canvas -> world
      const simMx = (mouseX / Math.max(1, CW)) * CFG.gridWidth;
      const simMy = ((CH - mouseY) / Math.max(1, CH)) * CFG.gridHeight;

      const applyMouse = CFG.mouseEnabled && (!CFG.mouseOnlyOnHover || hover);

      // Convert to world units/sec
      let vxW = 0;
      let vyW = 0;
      if (applyMouse) {
        vxW =
          (((dmx * CFG.mouseVelGain) / Math.max(1, CW)) * CFG.gridWidth) /
          Math.max(1e-6, dt);
        vyW =
          (((-dmy * CFG.mouseVelGain) / Math.max(1, CH)) * CFG.gridHeight) /
          Math.max(1e-6, dt);

        // Smooth + clamp
        const s = clamp(CFG.mouseSmoothing, 0, 0.98);
        mouseVelSmoothX = mouseVelSmoothX * s + vxW * (1 - s);
        mouseVelSmoothY = mouseVelSmoothY * s + vyW * (1 - s);

        const maxV = Math.max(1, CFG.mouseVelMax);
        vxW = clamp(mouseVelSmoothX, -maxV, maxV);
        vyW = clamp(mouseVelSmoothY, -maxV, maxV);

        vxW *= CFG.mouseForce;
        vyW *= CFG.mouseForce;
      } else {
        mouseVelSmoothX *= 0.9;
        mouseVelSmoothY *= 0.9;
      }

      // Reuse preallocated vectors (avoid per-frame arrays/GC).
      mouseVelocity[0] = vxW;
      mouseVelocity[1] = vyW;
      mouseVelocity[2] = 0;

      // Ray along +Z through the domain center for 2D-ish interaction
      mouseRayOrigin[0] = simMx;
      mouseRayOrigin[1] = simMy;
      mouseRayOrigin[2] = -1000;

      simulator.simulate(
        dt,
        mouseVelocity,
        mouseRayOrigin,
        mouseRayDirection,
      );
      readBackPositions();
      enforceSeparation();
      uploadCorrectedPositionsToGPU();
      updateDerivedState(dt);
      draw();

      mousePrevX = mouseX;
      mousePrevY = mouseY;
    }

    // Keep running only while the footer is near/visible.
    if (active) {
      rafId = requestAnimationFrame(tick);
    }
  }

  // Mouse events on the mount, not the canvas (mount has cursor:none)
  mount.addEventListener("mousemove", (e) => {
    const r = mount.getBoundingClientRect();
    mouseX = e.clientX - r.left;
    mouseY = e.clientY - r.top;
  });
  mount.addEventListener("mouseenter", () => (hover = true));
  mount.addEventListener("mouseleave", () => (hover = false));
  window.addEventListener("resize", () => {
    if (started) resize();
  });

  // Start the simulation only when the footer starts entering the viewport
  // from the bottom edge (i.e. footer top reaches viewport bottom).
  // This prevents the footer's GPU readback + CPU separation work from
  // competing with Lenis scrolling on the main thread.
  if (footerEl && "IntersectionObserver" in window) {
    const maybeKickstart = () => {
      // Layout can shift after initial script execution (fonts/CSS/images),
      // especially on production deploys. Re-check a few times so we don't
      // miss the initial visibility window and start "late".
      const rect = footerEl.getBoundingClientRect();
      // Trigger when the footer's top starts entering from the bottom.
      if (rect.top <= window.innerHeight) {
        active = true;
        if (!started) {
          started = true;
          resize();
        }
        ensureTick();
      }
    };

    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        const isIntersecting = !!entry?.isIntersecting;
        active = isIntersecting;

        if (active) {
          if (!started) {
            started = true;
            resize();
          }
          ensureTick();
        }
      },
      {
        threshold: 0.0,
        // Fire as soon as the footer touches the viewport (top hits bottom).
        rootMargin: "0px 0px",
      },
    );

    io.observe(footerEl);

    // Kickstart if the footer is already visible (short pages) and re-check
    // after layout settles (common on production).
    maybeKickstart();
    requestAnimationFrame(maybeKickstart);
    window.addEventListener("load", maybeKickstart, { once: true });
    setTimeout(maybeKickstart, 750);
  } else {
    // Fallback if IntersectionObserver isn't available.
    active = true;
    started = true;
    resize();
    ensureTick();
  }

  // DevTools helper: tweak CFG then call footerFluid.restart()
  window.footerFluid = {
    CFG,
    restart: () => {
      started = true;
      active = true;
      resize();
      ensureTick();
    },
  };

  // Keep the custom cursor logic as-is.
  const cur = document.getElementById("footer-cursor"),
    ft = document.querySelector("footer");
  if (cur && ft) {
    let cx = 0,
      cy = 0,
      tx = 0,
      ty = 0;
    ft.addEventListener("mousemove", (e) => {
      tx = e.clientX;
      ty = e.clientY;
      cur.classList.add("active");
    });
    ft.addEventListener("mouseleave", () => cur.classList.remove("active"));
    (function t() {
      cx += (tx - cx) * 0.15;
      cy += (ty - cy) * 0.15;
      cur.style.left = cx + "px";
      cur.style.top = cy + "px";
      requestAnimationFrame(t);
    })();
  }
})();
