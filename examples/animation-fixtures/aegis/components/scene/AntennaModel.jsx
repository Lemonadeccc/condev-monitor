"use client";

import { useLayoutEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF, useScroll } from "@react-three/drei";
import { Box3, Color } from "three";
import { MeshStandardNodeMaterial } from "three/webgpu";
import {
  abs,
  dot,
  float,
  fract,
  fwidth,
  max,
  mx_noise_float,
  normalView,
  positionLocal,
  positionViewDirection,
  positionWorld,
  pow,
  smoothstep,
  time,
  uniform,
  vec3,
  vec4,
} from "three/tsl";
import {
  ANTENNA_CONFIG,
  getModelReveal,
} from "@/lib/sceneConfig";

const MODEL_URL = "/assets/antenna-BhiT2yrk.glb";

function createAntennaMaterial() {
  const uniforms = {
    progress: uniform(0.1),
    boundsMinY: uniform(0),
    boundsHeight: uniform(1),
    edgeColor: uniform(new Color(ANTENNA_CONFIG.edgeColor)),
    edgeIntensity: uniform(ANTENNA_CONFIG.edgeIntensity),
    edgeWidth: uniform(ANTENNA_CONFIG.edgeWidth),
    edgeNoiseScale: uniform(ANTENNA_CONFIG.edgeNoiseScale),
    edgeNoiseSpeed: uniform(ANTENNA_CONFIG.edgeNoiseSpeed),
    edgeNoiseAmount: uniform(ANTENNA_CONFIG.edgeNoiseAmount),
    bloomStrength: uniform(ANTENNA_CONFIG.bloomStrength),
    bodyColor: uniform(new Color(ANTENNA_CONFIG.bodyColor)),
    baseColor: uniform(new Color(ANTENNA_CONFIG.baseColor)),
    baseOpacity: uniform(ANTENNA_CONFIG.baseOpacity),
    baseRimStrength: uniform(ANTENNA_CONFIG.baseRimStrength),
    baseRimPower: uniform(ANTENNA_CONFIG.baseRimPower),
    baseGridStrength: uniform(ANTENNA_CONFIG.baseGridStrength),
    baseGridScale: uniform(ANTENNA_CONFIG.baseGridScale),
    baseGridWidth: uniform(ANTENNA_CONFIG.baseGridWidth),
    baseScanSpeed: uniform(ANTENNA_CONFIG.baseScanSpeed),
    baseEmissive: uniform(ANTENNA_CONFIG.baseEmissive),
  };

  const normalizedHeight = positionWorld.y
    .sub(uniforms.boundsMinY)
    .div(max(uniforms.boundsHeight, float(0.000001)));
  const noisePosition = positionLocal
    .add(vec3(time.mul(uniforms.edgeNoiseSpeed).mul(8), 0, 0))
    .mul(uniforms.edgeNoiseScale);
  const noisyHeight = normalizedHeight.add(
    mx_noise_float(noisePosition).mul(uniforms.edgeNoiseAmount)
  );
  const revealFront = uniforms.progress.mul(1.3).sub(0.15);
  const signedDistance = revealFront.sub(noisyHeight);
  const revealed = smoothstep(float(0), float(0.01), signedDistance);
  const ghost = float(1).sub(revealed);
  const edgeBand = smoothstep(
    uniforms.edgeWidth,
    float(0),
    abs(signedDistance)
  );

  const facing = dot(normalView, positionViewDirection).clamp(0, 1);
  const rim = pow(float(1).sub(facing), uniforms.baseRimPower).mul(
    uniforms.baseRimStrength
  );
  const gridPosition = positionLocal
    .mul(uniforms.baseGridScale)
    .add(vec3(0, time.mul(uniforms.baseScanSpeed), 0));

  const gridLine = (coordinate) => {
    const distanceToLine = float(0.5).sub(
      abs(fract(coordinate).sub(0.5))
    );
    const derivative = fwidth(coordinate);

    return float(1).sub(
      smoothstep(
        uniforms.baseGridWidth.sub(derivative),
        uniforms.baseGridWidth.add(derivative),
        distanceToLine
      )
    );
  };

  const gridX = gridLine(gridPosition.x);
  const gridY = gridLine(gridPosition.y);
  const gridZ = gridLine(gridPosition.z);
  const grid = max(max(gridX, gridY), gridZ).mul(
    uniforms.baseGridStrength
  );
  const baseStrength = max(rim, grid)
    .mul(uniforms.baseOpacity)
    .mul(ghost);
  const edgeStrength = edgeBand.mul(uniforms.edgeIntensity);

  const body = uniforms.bodyColor.mul(revealed);
  const base = uniforms.baseColor.mul(baseStrength);
  const edge = uniforms.edgeColor.mul(edgeStrength);
  const alpha = max(revealed, max(baseStrength, edgeStrength));

  const material = new MeshStandardNodeMaterial({
    transparent: true,
    depthWrite: true,
  });

  material.colorNode = vec4(body.add(base).add(edge), alpha);
  material.emissiveNode = uniforms.edgeColor
    .mul(edgeBand)
    .mul(uniforms.bloomStrength)
    .add(
      uniforms.baseColor
        .mul(baseStrength)
        .mul(uniforms.baseEmissive)
    );

  return { material, uniforms };
}

function syncConfig(uniforms) {
  uniforms.edgeColor.value.set(ANTENNA_CONFIG.edgeColor);
  uniforms.edgeIntensity.value = ANTENNA_CONFIG.edgeIntensity;
  uniforms.edgeWidth.value = ANTENNA_CONFIG.edgeWidth;
  uniforms.edgeNoiseScale.value = ANTENNA_CONFIG.edgeNoiseScale;
  uniforms.edgeNoiseSpeed.value = ANTENNA_CONFIG.edgeNoiseSpeed;
  uniforms.edgeNoiseAmount.value = ANTENNA_CONFIG.edgeNoiseAmount;
  uniforms.bloomStrength.value = ANTENNA_CONFIG.bloomStrength;
  uniforms.bodyColor.value.set(ANTENNA_CONFIG.bodyColor);
  uniforms.baseColor.value.set(ANTENNA_CONFIG.baseColor);
  uniforms.baseOpacity.value = ANTENNA_CONFIG.baseOpacity;
  uniforms.baseRimStrength.value = ANTENNA_CONFIG.baseRimStrength;
  uniforms.baseRimPower.value = ANTENNA_CONFIG.baseRimPower;
  uniforms.baseGridStrength.value = ANTENNA_CONFIG.baseGridStrength;
  uniforms.baseGridScale.value = ANTENNA_CONFIG.baseGridScale;
  uniforms.baseGridWidth.value = ANTENNA_CONFIG.baseGridWidth;
  uniforms.baseScanSpeed.value = ANTENNA_CONFIG.baseScanSpeed;
  uniforms.baseEmissive.value = ANTENNA_CONFIG.baseEmissive;
}

export function AntennaModel() {
  const gltf = useGLTF(MODEL_URL);
  const scroll = useScroll();
  const scene = useMemo(() => gltf.scene.clone(true), [gltf.scene]);
  const { material, uniforms } = useMemo(createAntennaMaterial, []);

  useLayoutEffect(() => {
    scene.traverse((object) => {
      if (object.isMesh) {
        object.material = material;
        object.castShadow = true;
      }
    });

    scene.updateWorldMatrix(true, true);
    const bounds = new Box3().setFromObject(scene);
    uniforms.boundsMinY.value = bounds.min.y;
    uniforms.boundsHeight.value = Math.max(
      bounds.max.y - bounds.min.y,
      0.000001
    );
  }, [material, scene, uniforms]);

  useFrame(() => {
    uniforms.progress.value = getModelReveal(scroll.offset);
    syncConfig(uniforms);
  });

  return <primitive object={scene} />;
}

useGLTF.preload(MODEL_URL);
