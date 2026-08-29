"use client";

import { useEffect, useRef, useState } from "react";
import { ScrambleText } from "./AnimatedText";
import { gsap, useGSAP } from "@/lib/gsapClient";
import { getScrollOffset } from "@/lib/scrollRuntime";
import { useReducedMotion } from "@/lib/useReducedMotion";

export function HudButton({
  at,
  children,
  onClick,
  variant = "default",
  className = "",
}) {
  const ref = useRef(null);
  const [{ height, width }, setSize] = useState({
    height: 0,
    width: 0,
  });
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    const element = ref.current;

    if (!element) {
      return undefined;
    }

    const observer = new ResizeObserver(([entry]) => {
      setSize({
        height: entry.contentRect.height,
        width: entry.contentRect.width,
      });
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useGSAP(
    () => {
      const element = ref.current;

      if (!element || reduceMotion) {
        return undefined;
      }

      if (at === undefined) {
        gsap.set(element, { opacity: 0 });
        const tween = gsap.to(element, {
          keyframes: {
            opacity: Array.from(
              { length: 12 },
              (_, index) => index % 2
            ),
            easeEach: "steps(1)",
          },
          duration: 0.4,
          delay: 0.6,
          onComplete: () => gsap.set(element, { opacity: 1 }),
        });

        return () => tween.kill();
      }

      let active = false;
      let cleanupCall = null;
      const update = () => {
        const nextActive = getScrollOffset() > at;

        if (nextActive === active) {
          return;
        }

        active = nextActive;
        cleanupCall?.kill();
        element.classList.remove("hud-revealing");

        if (active) {
          element.dispatchEvent(new Event("pointerenter"));
          element.offsetWidth;
          element.classList.add("hud-revealing");
          cleanupCall = gsap.delayedCall(1, () => {
            element.classList.remove("hud-revealing");
          });
        }
      };

      gsap.ticker.add(update);
      update();

      return () => {
        gsap.ticker.remove(update);
        cleanupCall?.kill();
        element.classList.remove("hud-revealing");
      };
    },
    {
      dependencies: [at, reduceMotion],
      scope: ref,
    }
  );

  return (
    <button
      ref={ref}
      className={`hud-button hud-btn hud-button--${variant} ${className}`}
      type="button"
      onClick={onClick}
    >
      <span
        className="hud-button__surface"
        aria-hidden="true"
      >
        <span className="hud-button__dotgrid" />
        <span className="hud-button__scan hud-scan" />
      </span>
      <span className="hud-button__content">
        {variant === "primary" ? (
          <span className="hud-button__arrow hud-pulse" />
        ) : null}
        {typeof children === "string" ? (
          <ScrambleText text={children} trigger="hover" />
        ) : (
          <span>{children}</span>
        )}
      </span>
      {width > 0 && height > 0 ? (
        <svg
          aria-hidden="true"
          className="hud-button__border"
          width={width}
          height={height}
        >
          <path
            className="hud-btn-border"
            d={[
              "M 0.75 0.75",
              `L ${width - 12} 0.75`,
              `L ${width - 0.75} 12`,
              `L ${width - 0.75} ${height - 0.75}`,
              `L 12 ${height - 0.75}`,
              `L 0.75 ${height - 12}`,
              "Z",
            ].join(" ")}
            fill="none"
            strokeWidth="1.5"
          />
        </svg>
      ) : null}
    </button>
  );
}
