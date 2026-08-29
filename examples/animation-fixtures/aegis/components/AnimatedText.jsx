"use client";

import { createElement, useLayoutEffect, useRef } from "react";
import { gsap, SplitText, useGSAP } from "@/lib/gsapClient";
import { useReducedMotion } from "@/lib/useReducedMotion";
import { getScrollOffset } from "@/lib/scrollRuntime";

function multiline(text) {
  return text.split("\n").flatMap((line, index) =>
    index === 0
      ? [line]
      : [
          createElement("br", { key: `br-${index}` }),
          line,
        ]
  );
}

export function ScrambleText({
  as = "span",
  chars = "upperCase",
  className,
  delay = 0,
  duration = 0.75,
  fade = 0.3,
  speed = 3,
  text,
  trigger = "mount",
}) {
  const ref = useRef(null);
  const reduceMotion = useReducedMotion();

  useGSAP(
    () => {
      const element = ref.current;

      if (!element || reduceMotion) {
        return undefined;
      }

      const lockWidth = () => {
        element.style.width = `${element.offsetWidth}px`;
      };
      const releaseWidth = () => {
        element.style.width = "";
      };
      const animate = () => {
        lockWidth();
        gsap.to(element, {
          duration,
          ease: "none",
          scrambleText: {
            chars,
            revealDelay: 0,
            speed,
            text,
          },
          onComplete: releaseWidth,
        });
      };
      const animateEntrance = () => {
        gsap.set(element, { opacity: 0 });
        lockWidth();

        const timeline = gsap.timeline({ delay });

        if (fade > 0) {
          timeline.to(
            element,
            {
              opacity: 1,
              duration: fade,
              ease: "power1.out",
            },
            0
          );
        }

        timeline.to(
          element,
          {
            duration,
            ease: "none",
            scrambleText: {
              chars,
              revealDelay: 0,
              speed,
              text,
            },
            onComplete: releaseWidth,
          },
          0
        );

        return timeline;
      };

      if (trigger === "mount") {
        const timeline = animateEntrance();
        return () => timeline.kill();
      }

      if (trigger === "inview") {
        const observer = new IntersectionObserver(
          ([entry]) => {
            if (entry?.isIntersecting) {
              animateEntrance();
              observer.disconnect();
            }
          },
          { threshold: 0.6 }
        );

        observer.observe(element);
        return () => observer.disconnect();
      }

      const interactive =
        element.closest("button, a") ?? element;
      interactive.addEventListener("pointerenter", animate);

      return () => {
        interactive.removeEventListener("pointerenter", animate);
      };
    },
    {
      dependencies: [
        chars,
        delay,
        duration,
        fade,
        reduceMotion,
        speed,
        text,
        trigger,
      ],
      scope: ref,
      revertOnUpdate: true,
    }
  );

  return createElement(
    as,
    {
      className,
      ref,
      style: {
        display: "inline-block",
      },
    },
    text
  );
}

export function FlickerText({
  as = "span",
  at,
  className,
  delay = 0,
  duration = 0.2,
  fade = 0,
  flashes = 2.5,
  idle = true,
  stagger = 0.5,
  text,
}) {
  const ref = useRef(null);
  const reduceMotion = useReducedMotion();

  useGSAP(
    () => {
      const element = ref.current;

      if (!element) {
        return undefined;
      }

      const scrollTriggered = at !== undefined;

      if (reduceMotion) {
        if (!scrollTriggered) {
          return undefined;
        }

        const update = () => {
          element.style.opacity =
            getScrollOffset() > at ? "1" : "0";
          element.style.transform = "none";
        };

        gsap.ticker.add(update);
        update();
        return () => gsap.ticker.remove(update);
      }

      const split = new SplitText(element, {
        type: "chars",
      });
      const characters = split.chars;
      const flashesSequence = Array.from(
        { length: Math.max(1, flashes) * 2 },
        (_, index) => index % 2
      );
      const timeline = gsap.timeline({
        delay: scrollTriggered ? 0 : delay,
        paused: scrollTriggered,
      });

      gsap.set(characters, { opacity: 0 });

      if (fade > 0) {
        timeline.fromTo(
          element,
          { opacity: 0 },
          {
            opacity: 1,
            duration: fade,
            ease: "power1.out",
          },
          0
        );
      }

      for (const character of characters) {
        const start = Math.random() * stagger;
        timeline
          .to(
            character,
            {
              keyframes: {
                opacity: flashesSequence,
                easeEach: "steps(1)",
              },
              duration,
            },
            start
          )
          .set(character, { opacity: 1 }, start + duration);
      }

      if (idle && characters.length) {
        const start = stagger + duration + 0.2;
        const count = Math.min(
          characters.length,
          Math.max(3, Math.round(characters.length * 0.3))
        );
        const shuffled = characters.map((_, index) => index);

        for (let index = shuffled.length - 1; index > 0; index -= 1) {
          const swap = Math.floor(Math.random() * (index + 1));
          [shuffled[index], shuffled[swap]] = [
            shuffled[swap],
            shuffled[index],
          ];
        }

        shuffled.slice(0, count).forEach((index, order) => {
          const time = start + order * 0.08;

          timeline
            .to(
              characters[index],
              {
                opacity: 0.12,
                duration: 0.06,
                ease: "steps(1)",
              },
              time
            )
            .to(
              characters[index],
              {
                opacity: 1,
                duration: 0.06,
                ease: "steps(1)",
              },
              time + 0.06
            );
        });
      }

      if (!scrollTriggered) {
        return () => {
          timeline.kill();
          split.revert();
        };
      }

      let active = false;
      const update = () => {
        const nextActive = getScrollOffset() > at;

        if (nextActive === active) {
          return;
        }

        active = nextActive;
        gsap.killTweensOf(element);

        if (active) {
          gsap.set(element, { opacity: 1, y: 0 });
          timeline.play(0);
        } else {
          timeline.pause();
          gsap.to(element, {
            opacity: 0,
            y: -4,
            ease: "expo.inOut",
            onComplete: () => timeline.pause(0),
          });
        }
      };

      gsap.ticker.add(update);
      update();

      return () => {
        gsap.ticker.remove(update);
        timeline.kill();
        split.revert();
      };
    },
    {
      dependencies: [
        at,
        delay,
        duration,
        fade,
        flashes,
        idle,
        reduceMotion,
        stagger,
        text,
      ],
      scope: ref,
      revertOnUpdate: true,
    }
  );

  return createElement(
    as,
    { className },
    createElement(
      "span",
      {
        key: text,
        ref,
        style: { display: "inline-block" },
      },
      multiline(text)
    )
  );
}

export function ScrollFlickerText(props) {
  return <FlickerText {...props} />;
}

export function RiseText({
  as = "p",
  children,
  className,
  delay = 0,
  duration = 0.7,
  y = 14,
}) {
  const ref = useRef(null);
  const reduceMotion = useReducedMotion();

  useGSAP(
    () => {
      if (!ref.current || reduceMotion) {
        return undefined;
      }

      const tween = gsap.from(ref.current, {
        opacity: 0,
        y,
        duration,
        delay,
        ease: "power2.out",
      });

      return () => tween.kill();
    },
    {
      dependencies: [delay, duration, reduceMotion, y],
      scope: ref,
    }
  );

  return createElement(as, { className, ref }, children);
}

export function useScrambledValue(
  value,
  {
    chars = "upperCase",
    duration = 0.75,
    smoothWidth = false,
    speed = 3,
  } = {}
) {
  const ref = useRef(null);
  const previous = useRef(null);
  const tween = useRef(null);
  const reduceMotion = useReducedMotion();

  useLayoutEffect(() => {
    const element = ref.current;

    if (!element) {
      return;
    }

    if (previous.current === null || reduceMotion) {
      if (smoothWidth) {
        element.style.display = "inline-block";
        element.style.whiteSpace = "nowrap";
        element.style.overflow = "hidden";
        element.style.textAlign = "right";
      }

      element.textContent = value;

      if (smoothWidth) {
        element.style.width = `${Math.ceil(
          element.offsetWidth
        )}px`;
      }

      previous.current = value;
      return;
    }

    if (previous.current === value) {
      return;
    }

    previous.current = value;
    tween.current?.kill();

    if (!smoothWidth) {
      tween.current = gsap.to(element, {
        duration,
        ease: "none",
        scrambleText: {
          chars,
          revealDelay: 0,
          speed,
          text: value,
        },
      });
      return;
    }

    const probe = element.cloneNode(false);
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    probe.style.pointerEvents = "none";
    probe.style.left = "-9999px";
    probe.style.top = "0";
    probe.style.width = "auto";
    probe.textContent = value;
    (element.parentElement ?? document.body).appendChild(probe);
    const width = Math.ceil(
      probe.getBoundingClientRect().width
    );
    probe.remove();

    const timeline = gsap.timeline();
    timeline.to(
      element,
      {
        duration,
        ease: "none",
        scrambleText: {
          chars,
          revealDelay: 0,
          speed,
          text: value,
        },
      },
      0
    );
    timeline.to(
      element,
      {
        duration,
        ease: "power2.out",
        width,
      },
      0
    );
    tween.current = timeline;
  }, [
    chars,
    duration,
    reduceMotion,
    smoothWidth,
    speed,
    value,
  ]);

  useLayoutEffect(
    () => () => {
      tween.current?.kill();
    },
    []
  );

  return ref;
}
