export const CAMERA_PHASE = {
  p1End: 0.55,
};

export const CAMERA_PATH = {
  turns: 1.15,
  startAngle: Math.PI * 0.25,
  radiusNear: 6,
  radiusMid: 4.4,
  radiusFar: 210,
  yBottom: 0.5,
  yTop: 10,
  yFinal: 30,
  targetYBottom: 4.8,
  targetYTop: 11.5,
  targetYFinal: 10,
  roll: -0.045,
  startSideShift: -3.5,
  shiftResorb: 0.22,
};

export const MOBILE_CAMERA = {
  breakpoint: 768,
  radiusScale: 1.35,
};

export const FINAL_CAMERA = {
  start: 0.85,
  radiusEnd: 130,
  yEnd: 85,
  targetYEnd: 4,
  sideShift: -90,
  shiftStart: 0.85,
  sideShiftMobile: -60,
  radiusEndMobile: 170,
  driftSpeed: -0.05,
};

export const INTRO_CAMERA = {
  angleOffset: -0.55,
  radius: 10,
  y: 1,
  targetY: -8,
};

export const INTRO_TIMING = {
  wireDelay: 1,
  wireDuration: 1.25,
  cameraDuration: 1.8,
  fogDuration: 1.2,
  fogScrollThreshold: 0.003,
};

export const ANTENNA_CONFIG = {
  edgeColor: "#ff521b",
  edgeIntensity: 1.2,
  edgeWidth: 0.053,
  edgeNoiseScale: 1.56,
  edgeNoiseSpeed: 0.05,
  edgeNoiseAmount: 0.19,
  bloomStrength: 4,
  bodyColor: "#260c66",
  baseColor: "#470000",
  baseOpacity: 0.5,
  baseRimStrength: 2.88,
  baseRimPower: 8,
  baseGridStrength: 2,
  baseGridScale: 4,
  baseGridWidth: 0.021,
  baseScanSpeed: 1.8,
  baseEmissive: 1,
};

export const POST_CONFIG = {
  bloomStrength: 0.33,
  bloomRadius: 0.5,
  bloomThreshold: 0,
  caStrength: 0.008,
  vignetteSmoothing: 0.27,
  vignetteExponent: 1.5,
  grainIntensity: 0.004,
  grainScale: 1.5,
  grainFps: 12,
};

export const TERRAIN_CONFIG = {
  valleyColor: "#140606",
  midColor: "#3d1a10",
  crestColor: "#ff6a30",
  midPoint: 0.45,
  contrast: 1.5,
  crestThreshold: 0.68,
  crestEmissive: 2,
  hazeColor: "#240505",
  hazeStrength: 0.7,
  wireColor: "#ff9a5c",
  wirePulse: 2,
  wireHeightMin: 0.08,
  wireHeightSoft: 1,
};

export const TERRAIN_GEOMETRY = {
  angularSegments: 260,
  radialSegments: 72,
  innerRadius: 14,
  outerRadius: 112,
  innerFade: 14,
  outerFade: 34,
  noiseScale: 0.016,
  heightScale: 17,
  heightFloor: 0.18,
  heightPowerScale: 4,
  baseYOffset: 1.5,
};

export const GRID_CONFIG = {
  size: 400,
  groundColor: "#140404",
  lineColor: "#ff7a33",
  crossColor: "#ffcaa0",
  groundOpacity: 0.35,
  lineOpacity: 0.22,
  crossOpacity: 1.2,
  inner: 16,
  fadeStart: 90,
  fadeEnd: 190,
  scale: 1,
  lineDensity: 0.5,
  lineThickness: 0.015,
  crossDensity: 0.5,
  crossThickness: 1,
  crossSize: 0.04,
  scanSpeed: 0.25,
  scanFrequency: 0.03,
  scanSharpness: 8,
  scanFloor: 0.1,
  scanPeak: 1.6,
  reflection: 2,
};

export const DUST_LAYER = 1;

export const HEX_SPHERE_CONFIG = {
  radius: 23,
  scale: 5,
  frequency: 36,
  cellFade: 0,
  cellJitter: 0.061,
  edgeColor: "#dffbff",
  edgeIntensity: 20,
  edgeWidth: 0.05,
  edgeFlash: 0,
  bloomStrength: 0,
  edgeNoiseScale: 0.55,
  edgeNoiseSpeed: 0.02,
  edgeNoiseAmount: 0.1,
  cellGap: 0,
  hexEdgeColor: "#ff0000",
  hexEdgeIntensity: 1.11,
  hexEdgeWidth: 0,
  hexEdgeBloom: 10,
  bodyColor: "#ff0600",
  fillOpacity: 0,
  minVisibility: 0,
  energyColor: "#ff0600",
  energyIntensity: 0,
  energyScale: 0.2,
  energySpeed: 0.4,
  energyContrast: 4.67,
  baseColor: "#ff4d00",
  baseOpacity: 0,
  baseRimStrength: 1.34,
  baseRimPower: 4,
  baseEmissive: 10,
};

export function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

export function spanProgress(value, start, end) {
  return clamp((value - start) / (end - start));
}

export function smoothstep(value) {
  return value * value * (3 - 2 * value);
}

export function lerp(start, end, amount) {
  return start + (end - start) * amount;
}

export function getModelReveal(progress) {
  return spanProgress(progress, 0, CAMERA_PHASE.p1End);
}

export function getFogDensity(reveal) {
  return lerp(0.03, 0.002, clamp(reveal));
}

export function getGroundPulse(progress) {
  const enter = spanProgress(progress, 0.02, 0.14);
  const exit =
    1 -
    spanProgress(
      progress,
      CAMERA_PHASE.p1End - 0.08,
      CAMERA_PHASE.p1End + 0.06
    );

  return enter * exit;
}

export function getBeamTip(progress) {
  if (progress <= CAMERA_PHASE.p1End) {
    return (progress / CAMERA_PHASE.p1End) * 0.12;
  }

  return (
    0.12 +
    (1 - 0.12) *
      smoothstep(spanProgress(progress, CAMERA_PHASE.p1End, 0.72))
  );
}

export function getBeamIntensity(progress) {
  const enter = spanProgress(progress, 0.04, 0.18);
  const ignition = Math.max(0, 1 - Math.abs(progress - 0.72) / 0.05);
  const exit = 1 - spanProgress(progress, 0.82, 0.96);

  return (0.5 * enter + 0.9 * ignition) * exit;
}

export function getSphereReveal(progress) {
  return spanProgress(progress, 0.74, 1) * 0.5;
}

export function getParallaxIntensityScale(progress) {
  const enter = spanProgress(progress, 0.55, 0.67);
  const exit = 1 - spanProgress(progress, 0.78, 0.9);
  const pulse = smoothstep(Math.min(enter, exit));

  return lerp(1, 0.1, pulse);
}

export function easeOutCubic(value) {
  const progress = clamp(value);
  return 1 - Math.pow(1 - progress, 3);
}

export function easeInOutCubic(value) {
  const progress = clamp(value);

  return progress < 0.5
    ? 4 * progress * progress * progress
    : 1 - Math.pow(-2 * progress + 2, 3) / 2;
}

export function getIntroCameraBlend(elapsed) {
  return 1 - easeInOutCubic(elapsed / INTRO_TIMING.cameraDuration);
}

export function getIntroWireHide(elapsed) {
  const progress =
    (elapsed - INTRO_TIMING.wireDelay) / INTRO_TIMING.wireDuration;

  return 1 - easeOutCubic(progress);
}

export function getIntroFogReveal(elapsed) {
  return easeInOutCubic(elapsed / INTRO_TIMING.fogDuration);
}

export function getCameraRoll(progress) {
  const enter = smoothstep(spanProgress(progress, 0, 0.12));
  const exit =
    1 -
    smoothstep(
      spanProgress(progress, CAMERA_PHASE.p1End, FINAL_CAMERA.start)
    );

  return CAMERA_PATH.roll * enter * exit;
}

export function getSideShift(progress, mobile) {
  if (mobile) {
    return (
      FINAL_CAMERA.sideShiftMobile *
      smoothstep(spanProgress(progress, FINAL_CAMERA.shiftStart, 1))
    );
  }

  const introShift =
    CAMERA_PATH.startSideShift *
    (1 -
      smoothstep(spanProgress(progress, 0, CAMERA_PATH.shiftResorb)));
  const finalShift =
    FINAL_CAMERA.sideShift *
    smoothstep(spanProgress(progress, FINAL_CAMERA.shiftStart, 1));

  return introShift + finalShift;
}
