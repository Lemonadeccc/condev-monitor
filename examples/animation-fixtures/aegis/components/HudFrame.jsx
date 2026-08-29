"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const HUD_GEOMETRY = {
  pad: 30,
  padMobile: 16,
  corner: 30,
  depth: 16,
  bevel: 16,
  sideTop: 0.3,
  sideBottom: 0.7,
  notchWidth: 320,
  notchDepth: 26,
  notchBevel: 18,
};

const MOBILE_BREAKPOINT = 768;

function desktopFramePath(width, height) {
  const {
    pad,
    corner,
    depth,
    bevel,
    notchWidth,
    notchDepth,
    notchBevel,
    sideTop,
    sideBottom,
  } = HUD_GEOMETRY;

  const left = pad;
  const right = width - pad;
  const top = pad;
  const bottom = height - pad;
  const innerLeft = pad + depth;
  const innerRight = width - pad - depth;
  const sideStart = height * sideTop;
  const sideEnd = height * sideBottom;
  const center = width / 2;
  const notchLeft = center - notchWidth / 2;
  const notchRight = center + notchWidth / 2;
  const notchTop = bottom - notchDepth;

  return [
    `M ${left + corner} ${top}`,
    `L ${right - corner} ${top}`,
    `L ${right} ${top + corner}`,
    `L ${right} ${sideStart}`,
    `L ${innerRight} ${sideStart + bevel}`,
    `L ${innerRight} ${sideEnd - bevel}`,
    `L ${right} ${sideEnd}`,
    `L ${right} ${bottom - corner}`,
    `L ${right - corner} ${bottom}`,
    `L ${notchRight} ${bottom}`,
    `L ${notchRight - notchBevel} ${notchTop}`,
    `L ${notchLeft + notchBevel} ${notchTop}`,
    `L ${notchLeft} ${bottom}`,
    `L ${left + corner} ${bottom}`,
    `L ${left} ${bottom - corner}`,
    `L ${left} ${sideEnd}`,
    `L ${innerLeft} ${sideEnd - bevel}`,
    `L ${innerLeft} ${sideStart + bevel}`,
    `L ${left} ${sideStart}`,
    `L ${left} ${top + corner}`,
    `L ${left + corner} ${top}`,
    "Z",
  ].join(" ");
}

function mobileFramePath(width, height) {
  const { padMobile, corner } = HUD_GEOMETRY;
  const left = padMobile;
  const right = width - padMobile;
  const top = padMobile;
  const bottom = height - padMobile;

  return [
    `M ${left + corner} ${top}`,
    `L ${right - corner} ${top}`,
    `L ${right} ${top + corner}`,
    `L ${right} ${bottom - corner}`,
    `L ${right - corner} ${bottom}`,
    `L ${left + corner} ${bottom}`,
    `L ${left} ${bottom - corner}`,
    `L ${left} ${top + corner}`,
    `L ${left + corner} ${top}`,
    "Z",
  ].join(" ");
}

function getFramePath(width, height) {
  if (width === 0 || height === 0) {
    return "";
  }

  return width < MOBILE_BREAKPOINT
    ? mobileFramePath(width, height)
    : desktopFramePath(width, height);
}

export function HudFrame() {
  const frameRef = useRef(null);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const frame = frameRef.current;

    if (!frame) {
      return undefined;
    }

    const observer = new ResizeObserver(([entry]) => {
      setBounds({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });

    observer.observe(frame);

    return () => observer.disconnect();
  }, []);

  const path = useMemo(
    () => getFramePath(bounds.width, bounds.height),
    [bounds.height, bounds.width]
  );

  return (
    <div ref={frameRef} className="hud-frame" aria-hidden="true">
      {path ? (
        <svg
          className="hud-frame__svg"
          width={bounds.width}
          height={bounds.height}
          viewBox={`0 0 ${bounds.width} ${bounds.height}`}
        >
          <path d={path} />
        </svg>
      ) : null}
    </div>
  );
}
