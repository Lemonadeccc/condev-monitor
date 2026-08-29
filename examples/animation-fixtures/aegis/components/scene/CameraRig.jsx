"use client";

import { useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { useScroll } from "@react-three/drei";
import { Quaternion, Vector3 } from "three";
import {
  CAMERA_PATH,
  CAMERA_PHASE,
  FINAL_CAMERA,
  INTRO_CAMERA,
  MOBILE_CAMERA,
  getCameraRoll,
  getIntroCameraBlend,
  getParallaxIntensityScale,
  getSideShift,
  lerp,
  smoothstep,
  spanProgress,
} from "@/lib/sceneConfig";
import { updateScrollRuntime } from "@/lib/scrollRuntime";
import { getElapsed } from "./IntroClock";

function setCameraPath(progress, position, target, mobile) {
  const climb = smoothstep(spanProgress(progress, 0, CAMERA_PHASE.p1End));
  const pullback = smoothstep(
    spanProgress(progress, CAMERA_PHASE.p1End, FINAL_CAMERA.start)
  );
  const final = smoothstep(spanProgress(progress, FINAL_CAMERA.start, 1));
  const angle =
    CAMERA_PATH.startAngle + progress * CAMERA_PATH.turns * Math.PI * 2;

  let radius;
  let y;
  let targetY;

  if (progress <= CAMERA_PHASE.p1End) {
    radius = lerp(CAMERA_PATH.radiusNear, CAMERA_PATH.radiusMid, climb);

    if (mobile) {
      radius *= lerp(MOBILE_CAMERA.radiusScale, 1, climb);
    }

    y = lerp(CAMERA_PATH.yBottom, CAMERA_PATH.yTop, climb);
    targetY = lerp(
      CAMERA_PATH.targetYBottom,
      CAMERA_PATH.targetYTop,
      climb
    );
  } else if (progress <= FINAL_CAMERA.start) {
    radius = lerp(CAMERA_PATH.radiusMid, CAMERA_PATH.radiusFar, pullback);
    y = lerp(CAMERA_PATH.yTop, CAMERA_PATH.yFinal, pullback);
    targetY = lerp(
      CAMERA_PATH.targetYTop,
      CAMERA_PATH.targetYFinal,
      pullback
    );
  } else {
    radius = lerp(
      CAMERA_PATH.radiusFar,
      mobile ? FINAL_CAMERA.radiusEndMobile : FINAL_CAMERA.radiusEnd,
      final
    );
    y = lerp(CAMERA_PATH.yFinal, FINAL_CAMERA.yEnd, final);
    targetY = lerp(
      CAMERA_PATH.targetYFinal,
      FINAL_CAMERA.targetYEnd,
      final
    );
  }

  position.set(Math.sin(angle) * radius, y, Math.cos(angle) * radius);
  target.set(0, targetY, 0);
}

function applySideShift(position, target, amount, right, forward) {
  if (amount === 0) {
    return;
  }

  forward.copy(target).sub(position).normalize();
  right.set(-forward.z, 0, forward.x).normalize();
  position.addScaledVector(right, amount);
  target.addScaledVector(right, amount);
}

function setIntroCamera(position, target) {
  const angle = CAMERA_PATH.startAngle + INTRO_CAMERA.angleOffset;

  position.set(
    Math.sin(angle) * INTRO_CAMERA.radius,
    INTRO_CAMERA.y,
    Math.cos(angle) * INTRO_CAMERA.radius
  );
  target.set(0, INTRO_CAMERA.targetY, 0);
}

export function CameraRig({ introRuntime, reduceMotion = false }) {
  const scroll = useScroll();
  const { camera, pointer, size } = useThree();
  const state = useMemo(
    () => ({
      position: new Vector3(),
      target: new Vector3(),
      introPosition: new Vector3(),
      introTarget: new Vector3(),
      right: new Vector3(),
      forward: new Vector3(),
      orbitOffset: new Vector3(),
      pitchAxis: new Vector3(),
      pivot: new Vector3(),
      upAxis: new Vector3(0, 1, 0),
      baseQuaternion: new Quaternion(),
      yawQuaternion: new Quaternion(),
      pitchQuaternion: new Quaternion(),
      deltaQuaternion: new Quaternion(),
    }),
    []
  );
  const pointerMotion = useRef({ yaw: 0, pitch: 0 });
  const driftAngle = useRef(0);

  useFrame((_, delta) => {
    const progress = scroll.offset;
    const mobile = size.width < MOBILE_CAMERA.breakpoint;
    const introBlend = getIntroCameraBlend(
      getElapsed(introRuntime.now, introRuntime.startedAt)
    );

    updateScrollRuntime(progress, scroll.el);
    setCameraPath(progress, state.position, state.target, mobile);

    if (introBlend > 0) {
      setIntroCamera(state.introPosition, state.introTarget);
      state.position.lerp(state.introPosition, introBlend);
      state.target.lerp(state.introTarget, introBlend);
    }

    const finalBlend = smoothstep(
      spanProgress(progress, FINAL_CAMERA.start, 1)
    );

    if (!reduceMotion) {
      driftAngle.current +=
        FINAL_CAMERA.driftSpeed * finalBlend * delta;
    }

    if (driftAngle.current !== 0) {
      const dx = state.position.x - state.target.x;
      const dz = state.position.z - state.target.z;
      const cosine = Math.cos(driftAngle.current);
      const sine = Math.sin(driftAngle.current);

      state.position.x = state.target.x + dx * cosine - dz * sine;
      state.position.z = state.target.z + dx * sine + dz * cosine;
    }

    applySideShift(
      state.position,
      state.target,
      getSideShift(progress, mobile),
      state.right,
      state.forward
    );

    camera.position.copy(state.position);
    camera.lookAt(state.target);
    camera.rotateZ(getCameraRoll(progress));

    if (!reduceMotion) {
      const pointerStrength =
        0.1 * getParallaxIntensityScale(progress);
      const damping = 1 - Math.exp(-3 * delta);
      pointerMotion.current.yaw +=
        (pointer.x * pointerStrength - pointerMotion.current.yaw) *
        damping;
      pointerMotion.current.pitch +=
        (pointer.y * pointerStrength - pointerMotion.current.pitch) *
        damping;

      state.baseQuaternion.copy(camera.quaternion);
      state.forward
        .set(0, 0, -1)
        .applyQuaternion(state.baseQuaternion);
      state.pivot
        .copy(state.forward)
        .multiplyScalar(camera.position.length() || 1)
        .add(camera.position);
      state.pitchAxis
        .set(1, 0, 0)
        .applyQuaternion(state.baseQuaternion)
        .normalize();
      state.yawQuaternion.setFromAxisAngle(
        state.upAxis,
        pointerMotion.current.yaw
      );
      state.pitchQuaternion.setFromAxisAngle(
        state.pitchAxis,
        -pointerMotion.current.pitch
      );
      state.deltaQuaternion
        .copy(state.yawQuaternion)
        .multiply(state.pitchQuaternion);
      state.orbitOffset
        .copy(camera.position)
        .sub(state.pivot)
        .applyQuaternion(state.deltaQuaternion);
      camera.position.copy(state.pivot).add(state.orbitOffset);
      camera.quaternion
        .copy(state.deltaQuaternion)
        .multiply(state.baseQuaternion);
    }

    camera.updateMatrixWorld();
  }, -10);

  return null;
}
