import gsap from "gsap";
import { Observer } from "gsap/Observer";

gsap.registerPlugin(Observer);

const clients = [
  { name: "Cloudform", logo: "/clients/client-logo-1.svg" },
  { name: "Opal", logo: "/clients/client-logo-2.svg" },
  { name: "Oasis", logo: "/clients/client-logo-3.svg" },
  { name: "Arc", logo: "/clients/client-logo-4.svg" },
  { name: "Mainpoint", logo: "/clients/client-logo-5.svg" },
];

const RADII = ["0.75rem", "5rem"];

// ─── horizontalLoop (GreenSock helper) ───────────────────────────────────────

function horizontalLoop(items, config) {
  items = gsap.utils.toArray(items);
  config = config || {};
  let tl = gsap.timeline({
      repeat: config.repeat,
      paused: config.paused,
      defaults: { ease: "none" },
      onReverseComplete: () => tl.totalTime(tl.rawTime() + tl.duration() * 100),
    }),
    length = items.length,
    startX = items[0].offsetLeft,
    times = [],
    widths = [],
    xPercents = [],
    pixelsPerSecond = (config.speed || 1) * 100,
    snap = config.snap === false ? (v) => v : gsap.utils.snap(config.snap || 1),
    totalWidth,
    curX,
    distanceToStart,
    distanceToLoop,
    item,
    i;

  gsap.set(items, {
    xPercent: (i, el) => {
      let w = (widths[i] = parseFloat(gsap.getProperty(el, "width", "px")));
      xPercents[i] = snap(
        (parseFloat(gsap.getProperty(el, "x", "px")) / w) * 100 +
          gsap.getProperty(el, "xPercent"),
      );
      return xPercents[i];
    },
  });
  gsap.set(items, { x: 0 });
  totalWidth =
    items[length - 1].offsetLeft +
    (xPercents[length - 1] / 100) * widths[length - 1] -
    startX +
    items[length - 1].offsetWidth *
      gsap.getProperty(items[length - 1], "scaleX") +
    (parseFloat(config.paddingRight) || 0);

  for (i = 0; i < length; i++) {
    item = items[i];
    curX = (xPercents[i] / 100) * widths[i];
    distanceToStart = item.offsetLeft + curX - startX;
    distanceToLoop =
      distanceToStart + widths[i] * gsap.getProperty(item, "scaleX");
    tl.to(
      item,
      {
        xPercent: snap(((curX - distanceToLoop) / widths[i]) * 100),
        duration: distanceToLoop / pixelsPerSecond,
      },
      0,
    )
      .fromTo(
        item,
        {
          xPercent: snap(
            ((curX - distanceToLoop + totalWidth) / widths[i]) * 100,
          ),
        },
        {
          xPercent: xPercents[i],
          duration:
            (curX - distanceToLoop + totalWidth - curX) / pixelsPerSecond,
          immediateRender: false,
        },
        distanceToLoop / pixelsPerSecond,
      )
      .add("label" + i, distanceToStart / pixelsPerSecond);
    times[i] = distanceToStart / pixelsPerSecond;
  }

  tl.progress(1, true).progress(0, true);
  return tl;
}

// ─── BUILD DOM ────────────────────────────────────────────────────────────────

function buildRow(rowIndex) {
  const row = document.createElement("div");
  row.className = "clients-marquee-row";
  const COPIES = 6;
  for (let c = 0; c < COPIES; c++) {
    clients.forEach((client, i) => {
      const item = document.createElement("div");
      item.className = "clients-marquee-item";
      item.style.borderRadius = RADII[(i + rowIndex) % RADII.length];
      item.innerHTML = `<img src="${client.logo}" alt="${client.name}" draggable="false" />`;
      row.appendChild(item);
    });
  }
  return row;
}

function buildMarquee() {
  const section = document.querySelector(".clients");
  if (!section) return null;

  const wrapper = document.createElement("div");
  wrapper.className = "clients-marquee-wrapper";

  const row1 = buildRow(0);
  const row2 = buildRow(1);
  wrapper.appendChild(row1);
  wrapper.appendChild(row2);
  section.appendChild(wrapper);

  return { row1, row2 };
}

// ─── INIT ─────────────────────────────────────────────────────────────────────

function init() {
  const built = buildMarquee();
  if (!built) return;
  const { row1, row2 } = built;

  const SPEED = 1.5;
  const BASE = 1;
  const MAX_BOOST = BASE * 10; // caps how crazy the wheel/trackpad boost gets

  // Inertial smoothing:
  // - targetBoost updates directly from scroll delta (what user wants)
  // - currentBoost eases toward targetBoost every frame using power3.out
  const BOOST_SCALE = 0.055; // increase for more sensitivity
  const IDLE_MS = 95; // after this time with no scroll, start settling back
  const RAMP_SPEED = 10.5; // higher = snappier tracking to targetBoost
  const KICK_EPS = 0.02; // if we're basically at BASE, kick immediately on first scroll
  const KICK_LERP = 0.65; // how much of the boost to apply instantly

  const power3Out = (t) => 1 - Math.pow(1 - t, 3);

  const loop1 = horizontalLoop(row1.querySelectorAll(".clients-marquee-item"), {
    repeat: -1,
    speed: SPEED,
  });

  const loop2 = horizontalLoop(row2.querySelectorAll(".clients-marquee-item"), {
    repeat: -1,
    speed: SPEED,
  });

  // Row 1: forward (left), Row 2: jump to end then play backward (right)
  loop1.timeScale(BASE);

  // Seek to end so reverse has room to play, then set negative timeScale
  loop2.progress(1).timeScale(-BASE);

  // Smooth scroll boost (inertial tracking with power3.out per frame)
  let currentBoost = BASE;
  let targetBoost = BASE;
  let lastChangeAt = performance.now();
  let lastTickAt = performance.now();

  function tick() {
    const now = performance.now();
    const dt = Math.min((now - lastTickAt) / 1000, 0.05);
    lastTickAt = now;

    // When scrolling stops, settle targetBoost back to BASE.
    if (now - lastChangeAt > IDLE_MS) targetBoost = BASE;

    const t = Math.min(1, dt * RAMP_SPEED);
    const eased = power3Out(t);
    currentBoost += (targetBoost - currentBoost) * eased;
    currentBoost = gsap.utils.clamp(BASE, MAX_BOOST, currentBoost);

    loop1.timeScale(currentBoost);
    loop2.timeScale(-currentBoost);

    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  Observer.create({
    type: "wheel,scroll,touch",
    wheelSpeed: -1,
    onChange: (self) => {
      const now = performance.now();
      const rawDelta = Math.abs(self.deltaY ?? 0) || Math.abs(self.deltaX ?? 0);
      // Normalize/clamp delta so trackpads don't create huge jumps.
      const delta = Math.min(rawDelta, 120);

      const desiredBoost = gsap.utils.clamp(
        BASE,
        MAX_BOOST,
        BASE + Math.min(delta * BOOST_SCALE, MAX_BOOST - BASE),
      );
      targetBoost = desiredBoost;
      lastChangeAt = now;

      // First scroll after idle can feel "late" if we only ease per-frame.
      // Kick immediately toward the target, then the tick loop handles the rest.
      if (Math.abs(currentBoost - BASE) < KICK_EPS) {
        currentBoost = BASE + (desiredBoost - BASE) * KICK_LERP;
        loop1.timeScale(currentBoost);
        loop2.timeScale(-currentBoost);
      }
      lastTickAt = now;
    },
  });
}

init();
