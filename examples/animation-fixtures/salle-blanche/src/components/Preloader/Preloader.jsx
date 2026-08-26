"use client";

import { useEffect, useMemo, useState } from "react";
import { useLenis } from "lenis/react";

import Button from "@/components/Button/Button";

import "./Preloader.css";

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const EXIT_ANIMATION_MS = 700;

let isInitialLoad = true;

export default function Preloader({
  title = "Salle Blanche",
  duration = 2600,
  buttonText = "Enter Website",
  buttonHref = "#",
  onEnter,
  onAnimationComplete,
}) {
  const lenis = useLenis();
  const [isVisible, setIsVisible] = useState(isInitialLoad);
  const [isScrollLocked, setIsScrollLocked] = useState(isInitialLoad);
  const [progress, setProgress] = useState(0);
  const [hasFinishedLoading, setHasFinishedLoading] = useState(false);
  const [isExiting, setIsExiting] = useState(false);

  /* lock/unlock scroll while preloader is active */
  useEffect(() => {
    if (!isScrollLocked) {
      if (lenis) lenis.start();
      document.body.style.overflow = "";
      return;
    }

    if (lenis) lenis.stop();
    document.body.style.overflow = "hidden";

    return () => {
      if (lenis) lenis.start();
      document.body.style.overflow = "";
    };
  }, [lenis, isScrollLocked]);

  /* animate progress from 0 to 100 */
  useEffect(() => {
    if (!isVisible) return;

    let frameId = null;
    const startTime = performance.now();

    const tick = (now) => {
      const elapsed = now - startTime;
      const ratio = clamp(elapsed / duration, 0, 1);
      const percent = Math.round(ratio * 100);

      setProgress(percent);

      if (percent >= 100) {
        setHasFinishedLoading(true);
        return;
      }

      frameId = requestAnimationFrame(tick);
    };

    frameId = requestAnimationFrame(tick);

    return () => {
      if (frameId) cancelAnimationFrame(frameId);
    };
  }, [duration, isVisible]);

  const loadingText = useMemo(() => `Loading... ${progress}%`, [progress]);

  const handleEnterClick = (event) => {
    if (event) event.preventDefault();
    if (!hasFinishedLoading || isExiting) return;

    if (onEnter) onEnter(event);

    setIsExiting(true);
    setIsScrollLocked(false);

    window.setTimeout(() => {
      isInitialLoad = false;
      setIsVisible(false);
      if (onAnimationComplete) onAnimationComplete();
    }, EXIT_ANIMATION_MS);
  };

  if (!isVisible) return null;

  return (
    <section
      className={`preloader ${isExiting ? "is-exiting" : ""}`}
      aria-label="Website preloader"
    >
      <div className="preloader-inner">
        <div className="preloader-title-wrap">
          <h2 className="preloader-title preloader-title-base">{title}</h2>
          <h2
            className="preloader-title preloader-title-fill"
            style={{ width: `${progress}%` }}
          >
            {title}
          </h2>
        </div>

        <div className="preloader-action-slot">
          <p
            className={`preloader-loading ${hasFinishedLoading ? "is-hidden" : ""} mono`}
            aria-live="polite"
          >
            {loadingText}
          </p>

          <div
            className={`preloader-button-wrap ${hasFinishedLoading ? "is-visible" : ""}`}
          >
            <Button
              href={buttonHref}
              onClick={handleEnterClick}
              className="preloader-enter-button"
            >
              {buttonText}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

export { isInitialLoad };
