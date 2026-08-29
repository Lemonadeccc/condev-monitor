"use client";

import dynamic from "next/dynamic";
import {
  createElement,
  useCallback,
  useRef,
  useState,
} from "react";
import {
  FlickerText,
  RiseText,
  ScrambleText,
  ScrollFlickerText,
} from "./AnimatedText";
import { ContactOverlay } from "./ContactOverlay";
import { HudButton } from "./HudButton";
import { HudFrame } from "./HudFrame";
import { LoaderOverlay } from "./LoaderOverlay";
import { ScrollRail } from "./ScrollRail";
import {
  closingCopy,
  contactCopy,
  heroCopy,
  scrollSteps,
} from "@/data/siteContent";
import { gsap, useGSAP } from "@/lib/gsapClient";
import { getScrollOffset } from "@/lib/scrollRuntime";
import { useReducedMotion } from "@/lib/useReducedMotion";

const AegisCanvas = dynamic(
  () => import("./AegisCanvas").then((module) => module.AegisCanvas),
  {
    ssr: false,
  }
);

function FlashMount({
  as = "span",
  children,
  className,
  delay = 0.6,
  flashes = 4,
  ...props
}) {
  const ref = useRef(null);
  const reduceMotion = useReducedMotion();

  useGSAP(
    () => {
      if (!ref.current || reduceMotion) {
        return undefined;
      }

      gsap.set(ref.current, { opacity: 0 });
      const sequence = Array.from(
        { length: Math.max(1, flashes) * 2 },
        (_, index) => index % 2
      );
      const tween = gsap.to(ref.current, {
        keyframes: {
          opacity: sequence,
          easeEach: "steps(1)",
        },
        duration: 0.4,
        delay,
        onComplete: () => {
          gsap.set(ref.current, { opacity: 1 });
        },
      });

      return () => tween.kill();
    },
    {
      dependencies: [delay, flashes, reduceMotion],
      scope: ref,
    }
  );

  return createElement(
    as,
    { ...props, className, ref },
    children
  );
}

function ScrollExit({
  as = "div",
  at = 0.03,
  children,
  className,
  duration = 0.5,
  type = "fade",
}) {
  const ref = useRef(null);
  const reduceMotion = useReducedMotion();

  useGSAP(
    () => {
      const element = ref.current;

      if (!element) {
        return undefined;
      }

      if (reduceMotion) {
        const update = () => {
          element.style.opacity =
            getScrollOffset() > at ? "0" : "1";
          element.style.transform = "none";
        };

        gsap.ticker.add(update);
        update();
        return () => gsap.ticker.remove(update);
      }

      const timeline = gsap.timeline({ paused: true });

      if (type === "flash") {
        timeline.to(element, {
          keyframes: {
            opacity: [1, 0, 1, 0, 0],
            easeEach: "steps(1)",
          },
          duration,
        });
      } else {
        timeline.to(element, {
          opacity: 0,
          y: -4,
          ease: "expo.inOut",
        });
      }

      let active = false;
      const update = () => {
        const nextActive = getScrollOffset() > at;

        if (nextActive === active) {
          return;
        }

        active = nextActive;
        if (active) {
          timeline.play();
        } else {
          timeline.reverse();
        }
      };

      gsap.ticker.add(update);
      update();

      return () => {
        gsap.ticker.remove(update);
        timeline.kill();
      };
    },
    {
      dependencies: [at, duration, reduceMotion, type],
      scope: ref,
    }
  );

  return createElement(
    as,
    { className, ref },
    children
  );
}

function ScrollReveal({
  as = "div",
  at = 0.93,
  children,
  className,
  duration = 0.6,
}) {
  const ref = useRef(null);
  const reduceMotion = useReducedMotion();

  useGSAP(
    () => {
      const element = ref.current;

      if (!element) {
        return undefined;
      }

      if (reduceMotion) {
        const update = () => {
          element.style.opacity =
            getScrollOffset() > at ? "1" : "0";
          element.style.transform = "none";
        };

        gsap.ticker.add(update);
        update();
        return () => gsap.ticker.remove(update);
      }

      gsap.set(element, { opacity: 0, y: 8 });

      let active = false;
      const update = () => {
        const nextActive = getScrollOffset() > at;

        if (nextActive === active) {
          return;
        }

        active = nextActive;
        gsap.killTweensOf(element);

        if (active) {
          gsap.to(element, {
            opacity: 1,
            y: 0,
            ease: "expo.out",
            duration,
          });
        } else {
          gsap.to(element, {
            opacity: 0,
            y: -4,
            ease: "expo.inOut",
          });
        }
      };

      gsap.ticker.add(update);
      update();

      return () => {
        gsap.ticker.remove(update);
        gsap.killTweensOf(element);
      };
    },
    {
      dependencies: [at, duration, reduceMotion],
      scope: ref,
    }
  );

  return createElement(
    as,
    { className, ref },
    children
  );
}

function HudOverlay({ onOpenContact }) {
  return (
    <div className="hud-layer">
      <HudFrame />
      <span className="hud-left-accent" aria-hidden="true" />

      <FlashMount
        as="img"
        className="hud-logo"
        src="/logo.svg"
        alt="AEGIS"
      />

      <div className="hud-action">
        <HudButton onClick={onOpenContact}>REQUEST ACCESS</HudButton>
      </div>

      <section className="hud-copy hud-copy--hero">
        <ScrollExit
          as="span"
          className="hud-copy__marker-slot"
          type="flash"
        >
          <FlashMount className="hud-copy__marker" />
        </ScrollExit>
        <div>
          <ScrollExit>
            <FlickerText
              as="h1"
              delay={0.6}
              text={heroCopy.title}
            />
          </ScrollExit>
          <ScrollExit>
            <RiseText as="p" delay={1}>
              {heroCopy.body}
            </RiseText>
          </ScrollExit>
        </div>
      </section>

      <section className="hud-copy hud-copy--closing">
        <div>
          <ScrollFlickerText
            as="h2"
            at={0.93}
            text={closingCopy.title}
          />
          <ScrollReveal>
            <p>{closingCopy.body}</p>
          </ScrollReveal>
          <ScrollReveal>
            <HudButton
              at={0.93}
              variant="primary"
              onClick={onOpenContact}
            >
              {closingCopy.button}
            </HudButton>
          </ScrollReveal>
        </div>
      </section>

      <ScrollRail steps={scrollSteps} />

      <ScrollExit className="hud-scroll-hint">
        <ScrambleText
          delay={0.6}
          text="SCROLL TO DISCOVER"
        />
      </ScrollExit>
    </div>
  );
}

export function AegisExperience() {
  const [contactOpen, setContactOpen] = useState(false);
  const [hudVisible, setHudVisible] = useState(false);
  const [bootStatus, setBootStatus] = useState("loading");
  const [rendererState, setRendererState] = useState({
    backend: "",
    ready: false,
  });

  const handleSceneReady = useCallback((backend) => {
    setRendererState({
      backend,
      ready: true,
    });
  }, []);
  const handleRevealStart = useCallback(() => {
    setHudVisible(true);
  }, []);

  return (
    <main className="aegis-page">
      <AegisCanvas
        introStarted={hudVisible}
        onBootState={setBootStatus}
        onReady={handleSceneReady}
      />
      {hudVisible ? (
        <HudOverlay onOpenContact={() => setContactOpen(true)} />
      ) : null}

      {contactOpen ? (
        <ContactOverlay
          copy={contactCopy}
          onClose={() => setContactOpen(false)}
        />
      ) : null}

      <LoaderOverlay
        onRevealStart={handleRevealStart}
        ready={rendererState.ready}
        status={bootStatus}
      />
    </main>
  );
}
