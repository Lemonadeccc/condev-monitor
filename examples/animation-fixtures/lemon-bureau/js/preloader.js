import gsap from "gsap";
import { CustomEase } from "gsap/CustomEase";
import { SplitText } from "gsap/SplitText";

gsap.registerPlugin(CustomEase, SplitText);

const PRELOADER_SEEN_KEY = "preloaderSeen";
const PRELOADER_START_DELAY_S = 1;

function domReady(fn) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", fn, { once: true });
  } else {
    fn();
  }
}

function hidePreloaderNodes() {
  [".preloader", ".split-overlay", ".tags-overlay"].forEach((sel) => {
    const el = document.querySelector(sel);
    if (el) el.style.display = "none";
  });
}

domReady(() => {
  CustomEase.create("hop", ".8, 0, .3, 1");

  const preloader = document.querySelector(".preloader");
  const splitOverlay = document.querySelector(".split-overlay");
  const tagsOverlay = document.querySelector(".tags-overlay");

  // If markup isn't on this page, just no-op.
  if (!preloader || !splitOverlay || !tagsOverlay) {
    return;
  }

  const hasSeenPreloader =
    sessionStorage.getItem(PRELOADER_SEEN_KEY) === "true";
  if (hasSeenPreloader) {
    hidePreloaderNodes();
    return;
  }

  // Preloader is showing for this page load.
  document.documentElement.dataset.preloaderShowing = "true";
  document.documentElement.style.overflow = "hidden";

  const titles = document.querySelectorAll(
    ".preloader h1, .split-overlay h1, .tags-overlay p",
  );
  gsap.set(titles, { opacity: 0 });

  const splitTextElements = (
    selector,
    type = "words,chars",
    addFirstChar = false,
  ) => {
    const elements = document.querySelectorAll(selector);
    elements.forEach((element) => {
      const splitText = new SplitText(element, {
        type,
        wordsClass: "word",
        charsClass: "char",
      });

      if (type.includes("chars")) {
        splitText.chars.forEach((char, index) => {
          const originalText = char.textContent;
          char.innerHTML = `<span>${originalText}</span>`;
          if (addFirstChar && index === 0) char.classList.add("first-char");
        });
      }
    });
  };

  splitTextElements(".intro-title h1", "words, chars", true);
  splitTextElements(".tag p", "words");

  gsap.set(".split-overlay .intro-title .char span", { y: "0%" });

  const tl = gsap.timeline({
    defaults: { ease: "hop" },
    delay: PRELOADER_START_DELAY_S,
    onComplete: () => {
      sessionStorage.setItem(PRELOADER_SEEN_KEY, "true");
      document.documentElement.dataset.preloaderShowing = "false";
      document.documentElement.style.overflow = "";
      hidePreloaderNodes();
    },
  });

  const revealAfterBuffer = () => {
    gsap.delayedCall(PRELOADER_START_DELAY_S, () => {
      gsap.set(titles, { opacity: 1 });
    });
  };

  // Avoid FOUT-related SplitText flicker: wait for fonts, then reveal + run timeline.
  const fontsReady = document.fonts?.ready;
  if (fontsReady && typeof fontsReady.then === "function") {
    fontsReady.then(revealAfterBuffer).catch(revealAfterBuffer);
  } else {
    revealAfterBuffer();
  }

  const tags = gsap.utils.toArray(".tag");
  tags.forEach((tag, index) => {
    tl.to(
      tag.querySelectorAll("p .word"),
      { y: "0%", duration: 0.75 },
      0.5 + index * 0.1,
    );
  });

  tl.to(
    ".preloader .intro-title .char span",
    { y: "0%", duration: 0.75, stagger: 0.05 },
    0.5,
  )
    .to(
      ".split-overlay .intro-title .char span",
      { y: "0%", duration: 0.75, stagger: 0.05 },
      0.5,
    );

  // Tags exit after the title is in.
  tags.forEach((tag, index) => {
    tl.to(
      tag.querySelectorAll("p .word"),
      { y: "110%", duration: 0.75 },
      2 + index * 0.1,
    );
  });

  // Start the split + exit. (No X-motion / outro-number sequence.)
  tl.set(
    [".preloader", ".split-overlay"],
    {
      clipPath: (i) =>
        i === 0
          ? "polygon(0 0, 100% 0, 100% 50%, 0 50%)"
          : "polygon(0 50%, 100% 50%, 100% 100%, 0 100%)",
    },
    2.5,
  ).to(
    [".preloader", ".split-overlay"],
    {
      y: (i) => (i === 0 ? "-50%" : "50%"),
      duration: 1,
    },
    2.5,
  );

  // Timeline ends at 3.5s (2.5 + 1). With PRELOADER_START_DELAY_S=1 => 4.5s total.
});
