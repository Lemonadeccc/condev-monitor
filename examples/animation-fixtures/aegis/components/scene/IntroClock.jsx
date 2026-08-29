"use client";

import { useFrame } from "@react-three/fiber";
import { useScroll } from "@react-three/drei";
import { INTRO_TIMING } from "@/lib/sceneConfig";

export function createIntroRuntime() {
  return {
    fogStartedAt: null,
    now: 0,
    startedAt: null,
  };
}

export function getElapsed(now, startedAt) {
  return startedAt === null ? Number.NEGATIVE_INFINITY : now - startedAt;
}

export function IntroClock({
  introStarted,
  reduceMotion = false,
  runtime,
}) {
  const scroll = useScroll();

  useFrame(({ clock }) => {
    runtime.now = clock.elapsedTime;

    if (runtime.startedAt === null) {
      if (introStarted) {
        runtime.startedAt = reduceMotion
          ? runtime.now - 100
          : runtime.now;
      }

      return;
    }

    if (
      runtime.fogStartedAt === null &&
      scroll.offset > INTRO_TIMING.fogScrollThreshold
    ) {
      runtime.fogStartedAt = reduceMotion
        ? runtime.now - 100
        : runtime.now;
    }
  }, -20);

  return null;
}
