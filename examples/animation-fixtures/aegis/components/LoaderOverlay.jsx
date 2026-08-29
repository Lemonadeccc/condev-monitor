"use client";

import { useEffect, useRef, useState } from "react";
import { useProgress } from "@react-three/drei";
import { gsap, useGSAP } from "@/lib/gsapClient";
import { useReducedMotion } from "@/lib/useReducedMotion";
import { HudOrnament } from "./HudOrnament";

const STATUS_LABELS = {
  loading: "LOADING ASSETS",
  compiling: "COMPILING SHADERS",
  warming: "WARMING UP",
  ready: "READY",
};

export function LoaderOverlay({
  onRevealStart,
  ready,
  status,
}) {
  const { progress } = useProgress();
  const [hidden, setHidden] = useState(false);
  const overlayRef = useRef(null);
  const frameRef = useRef(null);
  const fillRef = useRef(null);
  const numberRef = useRef(null);
  const renderedProgress = useRef(0);
  const targetProgress = useRef(0);
  const reduceMotion = useReducedMotion();

  const target =
    status === "loading"
      ? progress * 0.8
      : status === "compiling"
        ? 90
        : status === "warming"
          ? 97
          : 100;
  targetProgress.current = Math.max(targetProgress.current, target);

  useEffect(() => {
    let frame = 0;

    const update = () => {
      renderedProgress.current +=
        (targetProgress.current - renderedProgress.current) * 0.12;
      const value = Math.min(100, renderedProgress.current);

      if (fillRef.current) {
        fillRef.current.style.height = `${value.toFixed(1)}%`;
      }

      if (numberRef.current) {
        numberRef.current.textContent = String(Math.round(value)).padStart(
          2,
          "0"
        );
      }

      frame = requestAnimationFrame(update);
    };

    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, []);

  useGSAP(
    () => {
      if (!ready || !overlayRef.current) {
        return;
      }

      if (reduceMotion) {
        onRevealStart?.();
        setHidden(true);
        return;
      }

      gsap
        .timeline()
        .to(frameRef.current, {
          scale: 0.35,
          duration: 1.2,
          ease: "power4.inOut",
        })
        .to(
          overlayRef.current,
          {
            opacity: 0,
            duration: 0.75,
            ease: "expo.inOut",
            onStart: onRevealStart,
            onComplete: () => setHidden(true),
          }
        );
    },
    {
      dependencies: [onRevealStart, ready, reduceMotion],
      scope: overlayRef,
    }
  );

  if (hidden) {
    return null;
  }

  return (
    <div
      ref={overlayRef}
      className="loader-overlay"
      aria-live="polite"
    >
      <HudOrnament
        bevels
        className="loader-overlay__outer"
        corners={false}
        ring={false}
      />
      <div ref={frameRef} className="loader-overlay__frame">
        <HudOrnament
          bevels={false}
          corners={false}
          outerCircle={false}
        />
      </div>
      <div className="loader-overlay__logo" aria-hidden="true">
        <span className="loader-overlay__logo-base" />
        <span
          ref={fillRef}
          className="loader-overlay__logo-fill"
        />
      </div>
      <div className="loader-overlay__status">
        {STATUS_LABELS[status] ?? "LOADING"}
      </div>
      <div className="loader-overlay__number">
        <span ref={numberRef}>00</span>%
      </div>
    </div>
  );
}
