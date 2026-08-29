"use client";

import { useEffect, useRef, useState } from "react";
import { useScrambledValue } from "./AnimatedText";
import {
  getScrollOffset,
  scrollToProgress,
} from "@/lib/scrollRuntime";
import { useReducedMotion } from "@/lib/useReducedMotion";

export function ScrollRail({ steps }) {
  const progressRef = useRef(null);
  const labelRef = useRef(null);
  const activeRef = useRef(0);
  const previousProgress = useRef(-1);
  const [activeStep, setActiveStep] = useState(0);
  const numberTextRef = useScrambledValue(
    String(activeStep + 1).padStart(2, "0"),
    { chars: "0123456789" }
  );
  const labelTextRef = useScrambledValue(steps[activeStep], {
    smoothWidth: true,
  });
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    let frame = 0;

    const update = () => {
      frame = requestAnimationFrame(update);

      const progress = Math.min(
        1,
        Math.max(0, getScrollOffset())
      );

      if (
        Math.abs(progress - previousProgress.current) < 0.0004
      ) {
        return;
      }

      previousProgress.current = progress;

      if (progressRef.current) {
        progressRef.current.style.transform = `scaleY(${progress})`;
      }

      if (labelRef.current) {
        labelRef.current.style.top = `${progress * 100}%`;
        labelRef.current.style.opacity =
          progress > 0.012 ? "1" : "0";
      }

      const nextStep = Math.min(
        steps.length - 1,
        Math.floor(progress * (steps.length - 1) + 0.0001)
      );

      if (nextStep !== activeRef.current) {
        activeRef.current = nextStep;
        setActiveStep(nextStep);
      }
    };

    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [steps.length]);

  return (
    <nav className="scroll-rail" aria-label="AEGIS scroll sections">
      <span
        ref={progressRef}
        className="scroll-rail__progress"
        style={{ transform: "scaleY(0)" }}
      />
      {steps.map((step, index) => {
        const progress =
          steps.length === 1 ? 0 : index / (steps.length - 1);
        const isActive = index <= activeStep;

        return (
          <button
            aria-label={step}
            className={isActive ? "is-active" : ""}
            key={step}
            type="button"
            onClick={() => {
              scrollToProgress(
                progress,
                reduceMotion ? "auto" : "smooth"
              );
            }}
            style={{ top: `${progress * 100}%` }}
          />
        );
      })}
      <div
        ref={labelRef}
        className="scroll-rail__label"
        style={{ top: 0, opacity: 0 }}
      >
        <span ref={numberTextRef} />
        <strong ref={labelTextRef} />
      </div>
    </nav>
  );
}
