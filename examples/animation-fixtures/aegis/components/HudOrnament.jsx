"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const FRAME = {
  pad: 30,
  corner: 30,
  depth: 16,
  bevel: 16,
  sideTop: 0.3,
  sideBottom: 0.7,
};
const MOBILE_BREAKPOINT = 768;
const TICK_COUNT = 300;
const TICK_LENGTH = 6;
const TICK_INSET = 9;
const CORNER_EXTENSION = 30;

export function HudOrnament({
  bevels = true,
  className = "",
  corners = true,
  outerCircle = true,
  ring = true,
}) {
  const ref = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = ref.current;

    if (!element) {
      return undefined;
    }

    const observer = new ResizeObserver(([entry]) => {
      setSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const geometry = useMemo(() => {
    const { width, height } = size;

    if (!width || !height) {
      return null;
    }

    const desktop = width >= MOBILE_BREAKPOINT;
    const drawCorners = corners && desktop;
    const drawBevels = bevels && desktop;
    const left = FRAME.pad;
    const right = width - FRAME.pad;
    const top = FRAME.pad;
    const bottom = height - FRAME.pad;
    const innerLeft = FRAME.pad + FRAME.depth;
    const innerRight = width - FRAME.pad - FRAME.depth;
    const sideStart = height * FRAME.sideTop;
    const sideEnd = height * FRAME.sideBottom;
    const centerX = width / 2;
    const centerY = height / 2;
    const radius = Math.min(width, height) * 0.6;
    const cornerTopEnd = drawBevels
      ? sideStart
      : top + FRAME.corner + CORNER_EXTENSION;
    const cornerBottomEnd = drawBevels
      ? sideEnd
      : bottom - FRAME.corner - CORNER_EXTENSION;
    const cornerPaths = [
      `M ${left + FRAME.corner + CORNER_EXTENSION} ${top} L ${
        left + FRAME.corner
      } ${top} L ${left} ${top + FRAME.corner} L ${left} ${cornerTopEnd}`,
      `M ${left + FRAME.corner + CORNER_EXTENSION} ${bottom} L ${
        left + FRAME.corner
      } ${bottom} L ${left} ${bottom - FRAME.corner} L ${left} ${cornerBottomEnd}`,
      `M ${right - FRAME.corner - CORNER_EXTENSION} ${top} L ${
        right - FRAME.corner
      } ${top} L ${right} ${top + FRAME.corner} L ${right} ${cornerTopEnd}`,
      `M ${right - FRAME.corner - CORNER_EXTENSION} ${bottom} L ${
        right - FRAME.corner
      } ${bottom} L ${right} ${bottom - FRAME.corner} L ${right} ${cornerBottomEnd}`,
    ];
    const bevelPaths = [
      `M ${left} ${sideStart} L ${innerLeft} ${
        sideStart + FRAME.bevel
      } L ${innerLeft} ${sideEnd - FRAME.bevel} L ${left} ${sideEnd}`,
      `M ${right} ${sideStart} L ${innerRight} ${
        sideStart + FRAME.bevel
      } L ${innerRight} ${sideEnd - FRAME.bevel} L ${right} ${sideEnd}`,
    ];
    const tickOuterRadius = radius - TICK_INSET;
    const tickInnerRadius = tickOuterRadius - TICK_LENGTH;
    const ticks = Array.from({ length: TICK_COUNT }, (_, index) => {
      const angle = (index / TICK_COUNT) * Math.PI * 2;
      const cosine = Math.cos(angle);
      const sine = Math.sin(angle);

      return {
        x1: centerX + cosine * tickInnerRadius,
        y1: centerY + sine * tickInnerRadius,
        x2: centerX + cosine * tickOuterRadius,
        y2: centerY + sine * tickOuterRadius,
      };
    });

    return {
      bevelPaths: drawBevels ? bevelPaths : [],
      centerX,
      centerY,
      cornerPaths: drawCorners ? cornerPaths : [],
      radius,
      ticks,
    };
  }, [bevels, corners, size]);

  return (
    <div
      ref={ref}
      className={`hud-ornament ${className}`}
      aria-hidden="true"
    >
      {geometry ? (
        <svg width={size.width} height={size.height}>
          <g
            fill="none"
            stroke="rgba(255, 255, 255, 0.16)"
            strokeWidth="1"
          >
            {ring ? (
              <>
                {outerCircle ? (
                  <circle
                    cx={geometry.centerX}
                    cy={geometry.centerY}
                    r={geometry.radius}
                  />
                ) : null}
                <g className="hud-spin">
                  {geometry.ticks.map((tick, index) => (
                    <line key={index} {...tick} />
                  ))}
                </g>
              </>
            ) : null}
            {geometry.cornerPaths.map((path) => (
              <path d={path} key={path} />
            ))}
            {geometry.bevelPaths.map((path) => (
              <path d={path} key={path} />
            ))}
          </g>
        </svg>
      ) : null}
    </div>
  );
}
