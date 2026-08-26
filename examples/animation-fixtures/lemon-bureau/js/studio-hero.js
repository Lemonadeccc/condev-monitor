import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

const hero = document.querySelector(".studio-hero");
if (hero) {
  // pin + animate hero on scroll
  ScrollTrigger.create({
    trigger: hero,
    start: "top top",
    end: () => `+=${window.innerHeight * 3}px`,
    id: "studio-hero-pin",
    pin: true,
    pinSpacing: true,
    scrub: true,
    invalidateOnRefresh: true,
    refreshPriority: 10,
    onUpdate: (self) => {
      const p = self.progress;

      gsap.set(".studio-hero-header:nth-child(1)", {
        x: -innerWidth * 3 * p,
        y: innerHeight * 0.5 * p,
        scale: 1 + 9 * p,
      });
      gsap.set(".studio-hero-header:nth-child(2)", {
        x: innerWidth * 3 * p,
        y: innerHeight * 0.5 * p,
        scale: 1 + 9 * p,
      });

      const startClip = {
        tl: 37.5,
        tt: 20,
        tr: 62.5,
        tb: 20,
        br: 62.5,
        bb: 80,
        bl: 37.5,
        bbt: 80,
      };
      const endClip = {
        tl: 0,
        tt: 0,
        tr: 100,
        tb: 0,
        br: 100,
        bb: 100,
        bl: 0,
        bbt: 100,
      };

      const lerp = (a, b) => a + (b - a) * p;

      gsap.set(".studio-hero-img", {
        rotation: 30 * (1 - p),
        clipPath: `polygon(
          ${lerp(startClip.tl, endClip.tl)}% ${lerp(startClip.tt, endClip.tt)}%,
          ${lerp(startClip.tr, endClip.tr)}% ${lerp(startClip.tb, endClip.tb)}%,
          ${lerp(startClip.br, endClip.br)}% ${lerp(startClip.bb, endClip.bb)}%,
          ${lerp(startClip.bl, endClip.bl)}% ${lerp(startClip.bbt, endClip.bbt)}%
        )`,
      });

      gsap.set(".studio-hero-img img", {
        scale: 2 - p,
      });
    },
  });

  // refresh scrolltrigger after assets settle
  const img = hero.querySelector(".studio-hero-img img");
  const refreshSoon = () =>
    requestAnimationFrame(() => ScrollTrigger.refresh());

  refreshSoon();
  window.addEventListener("load", refreshSoon, { once: true });

  if (img) {
    if (img.complete) {
      refreshSoon();
    } else {
      img.addEventListener("load", refreshSoon, { once: true });
      img.addEventListener("error", refreshSoon, { once: true });
    }
    img
      .decode?.()
      .then(refreshSoon)
      .catch(() => {});
  }

  document.fonts?.ready?.then(refreshSoon).catch(() => {});
}
