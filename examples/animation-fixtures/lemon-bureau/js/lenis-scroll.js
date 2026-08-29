import { init } from "@condev-monitor/monitor-sdk-browser/animation";
import Lenis from "lenis";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

const dsn = import.meta.env.VITE_MONITOR_DSN?.trim();

const monitorClient = init({
  dsn,
  animation: {
    autoStart: import.meta.env.DEV || Boolean(dsn),
    devtools: import.meta.env.DEV,
    rum: dsn ? { contractVersion: 2, sampleRate: 1 } : false,
    context: {
      routeKey: "lemon-bureau.home",
      environment: import.meta.env.MODE,
      runtimeFamily: "vanilla",
    },
  },
});

let lenis = null;
let motionSession = null;

gsap.registerPlugin(ScrollTrigger);

// initialization
// In production builds, this module can execute after DOMContentLoaded has
// already fired (depending on bundling/loading), so we must handle both cases.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => initLenisScroll());
} else {
  initLenisScroll();
}

// smooth scroll setup with responsive config
function initLenisScroll() {
  if (lenis) return;

  const isMobile = window.innerWidth <= 1000;

  lenis = new Lenis({
    duration: isMobile ? 0.8 : 1.2,
    lerp: isMobile ? 0.075 : 0.1,
    smoothWheel: true,
    syncTouch: true,
    touchMultiplier: isMobile ? 1.5 : 2,
  });

  motionSession = monitorClient.animation.createMotionObserverSession({
    gsapTicker: { ticker: gsap.ticker },
    lenisScroll: { lenis },
    scrollTrigger: { scrollTrigger: ScrollTrigger },
  });

  lenis.on("scroll", ScrollTrigger.update);
  gsap.ticker.add((time) => lenis.raf(time * 1000));
  gsap.ticker.lagSmoothing(0);

  window.lenis = lenis;

  // Ensure any existing ScrollTriggers (including pinned ones) measure using
  // the final layout + active Lenis loop.
  requestAnimationFrame(() => ScrollTrigger.refresh());
  window.addEventListener("load", () => ScrollTrigger.refresh(), { once: true });
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    motionSession?.dispose();
    motionSession = null;
  });
}

export { lenis, monitorClient };
