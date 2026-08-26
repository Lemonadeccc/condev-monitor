import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";

gsap.registerPlugin(ScrollTrigger, SplitText);

const PRELOADER_SEEN_KEY = "preloaderSeen";
const PRELOADER_HERO_DELAY_S = 3.25;

function domReady(fn) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", fn, { once: true });
  } else {
    fn();
  }
}

function getSplitTypeFromElement(element) {
  // Supported:
  // - data-animate-variant="slide" + data-animate-split="lines|words"
  // - data-animate-variant="slide-lines|slide-words"
  const variant = (element.getAttribute("data-animate-variant") || "").trim();
  if (variant === "slide-words") return "words";
  if (variant === "slide-lines") return "lines";

  const split = (element.getAttribute("data-animate-split") || "").trim();
  if (split === "words") return "words";
  return "lines";
}

function initSlideMaskAnimation(element, { isPreloaderShowing, hero }) {
  const animateOnScroll =
    element.getAttribute("data-animate-on-scroll") === "true";

  let delay = parseFloat(element.getAttribute("data-animate-delay")) || 0;

  // Match the older-project approach: apply a fixed delay only to hero
  // elements when the preloader is actually showing.
  if (
    isPreloaderShowing &&
    !animateOnScroll &&
    hero &&
    hero.contains(element)
  ) {
    delay += PRELOADER_HERO_DELAY_S;
  }

  const duration =
    parseFloat(element.getAttribute("data-animate-duration")) || 0.75;
  const stagger =
    parseFloat(element.getAttribute("data-animate-stagger")) || 0.1;
  const start = (
    element.getAttribute("data-animate-start") || "top 70%"
  ).trim();

  const splitType = getSplitTypeFromElement(element);

  SplitText.create(element, {
    type: splitType,
    mask: splitType,
    autoSplit: true,
    linesClass: "line",
    wordsClass: "word",
    onSplit(self) {
      const targets = splitType === "words" ? self.words : self.lines;

      gsap.set(targets, { yPercent: 100 });

      const animation = gsap.to(targets, {
        yPercent: 0,
        duration,
        ease: "power3.out",
        delay,
        stagger,
        paused: animateOnScroll,
      });

      if (animateOnScroll) {
        ScrollTrigger.create({
          trigger: element,
          start,
          animation,
          toggleActions: "play none none none",
        });
      }
    },
  });
}

export function initAnimatedCopy() {
  const preloader = document.querySelector(".preloader");
  const hasSeenPreloader =
    sessionStorage.getItem(PRELOADER_SEEN_KEY) === "true";
  const isPreloaderShowing = !!preloader && !hasSeenPreloader;
  const hero = document.querySelector(".hero");

  const animatedElements = document.querySelectorAll("[data-animate-variant]");

  animatedElements.forEach((element) => {
    const variant = element.getAttribute("data-animate-variant");
    const isSlide =
      variant === "slide" ||
      variant === "slide-lines" ||
      variant === "slide-words";
    if (!isSlide) return;

    initSlideMaskAnimation(element, { isPreloaderShowing, hero });
  });
}

domReady(() => {
  // Wait for layout-stable text metrics if possible.
  const fontsReady = document.fonts?.ready;
  if (fontsReady && typeof fontsReady.then === "function") {
    fontsReady.then(() => initAnimatedCopy());
  } else {
    initAnimatedCopy();
  }
});
