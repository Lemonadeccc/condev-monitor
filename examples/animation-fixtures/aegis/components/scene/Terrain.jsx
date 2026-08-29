"use client";

import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
} from "three";
import {
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
} from "three/webgpu";
import {
  attribute,
  float,
  mix,
  positionLocal,
  pow,
  sin,
  smoothstep,
  time,
  uniform,
  vec3,
  vec4,
} from "three/tsl";
import {
  TERRAIN_CONFIG,
  TERRAIN_GEOMETRY,
  getIntroWireHide,
} from "@/lib/sceneConfig";
import { getElapsed } from "./IntroClock";

function random2d(x, y) {
  const value = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return value - Math.floor(value);
}

function smooth(value) {
  return value * value * (3 - 2 * value);
}

function valueNoise(x, y) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);
  const a = random2d(x0, y0);
  const b = random2d(x0 + 1, y0);
  const c = random2d(x0, y0 + 1);
  const d = random2d(x0 + 1, y0 + 1);
  const x1 = a + (b - a) * fx;
  const x2 = c + (d - c) * fx;

  return (x1 + (x2 - x1) * fy) * 2 - 1;
}

function ridgedFbm(x, y) {
  let value = 0;
  let weight = 0.5;
  let frequency = 1;
  let totalWeight = 0;

  for (let octave = 0; octave < 5; octave += 1) {
    const ridge = Math.pow(
      1 - Math.abs(valueNoise(x * frequency, y * frequency)),
      2
    );

    value += ridge * weight;
    totalWeight += weight;
    frequency *= 2;
    weight *= 0.5;
  }

  return value / totalWeight;
}

function smoothRange(start, end, value) {
  const progress = Math.min(
    Math.max((value - start) / (end - start), 0),
    1
  );

  return progress * progress * (3 - 2 * progress);
}

function getHeightEnvelope(radialProgress) {
  const {
    heightFloor,
    heightPowerScale,
    heightScale,
  } = TERRAIN_GEOMETRY;

  return (
    heightScale *
    (heightFloor + heightPowerScale * Math.pow(radialProgress, 1.6))
  );
}

function createTerrainGeometry() {
  const {
    angularSegments,
    baseYOffset,
    innerFade,
    innerRadius,
    noiseScale,
    outerFade,
    outerRadius,
    radialSegments,
  } = TERRAIN_GEOMETRY;
  const angularCount = angularSegments + 1;
  const radialCount = radialSegments + 1;
  const positions = new Float32Array(
    angularCount * radialCount * 3
  );
  const heights = new Float32Array(angularCount * radialCount);
  let maxHeight = 0.000001;

  for (
    let angularIndex = 0;
    angularIndex < angularCount;
    angularIndex += 1
  ) {
    const angle =
      (angularIndex / angularSegments) * Math.PI * 2;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);

    for (
      let radialIndex = 0;
      radialIndex < radialCount;
      radialIndex += 1
    ) {
      const radialProgress = radialIndex / radialSegments;
      const radius =
        innerRadius +
        (outerRadius - innerRadius) * radialProgress;
      const x = cosine * radius;
      const z = sine * radius;
      const innerMask = smoothRange(
        innerRadius,
        innerRadius + innerFade,
        radius
      );
      const outerMask = smoothRange(
        outerRadius,
        outerRadius - outerFade,
        radius
      );
      const boundaryMask = Math.min(innerMask, outerMask);
      const height =
        ridgedFbm(x * noiseScale, z * noiseScale) *
        getHeightEnvelope(radialProgress) *
        boundaryMask;

      maxHeight = Math.max(maxHeight, height);

      const vertexIndex =
        angularIndex * radialCount + radialIndex;
      const positionIndex = vertexIndex * 3;

      heights[vertexIndex] = height;
      positions[positionIndex] = x;
      positions[positionIndex + 1] = height - baseYOffset;
      positions[positionIndex + 2] = z;
    }
  }

  const normalizedHeights = new Float32Array(heights.length);

  for (let index = 0; index < heights.length; index += 1) {
    normalizedHeights[index] = heights[index] / maxHeight;
  }

  const indices = [];
  const getIndex = (angularIndex, radialIndex) =>
    angularIndex * radialCount + radialIndex;

  for (
    let angularIndex = 0;
    angularIndex < angularSegments;
    angularIndex += 1
  ) {
    for (
      let radialIndex = 0;
      radialIndex < radialSegments;
      radialIndex += 1
    ) {
      const a = getIndex(angularIndex, radialIndex);
      const b = getIndex(angularIndex + 1, radialIndex);
      const c = getIndex(angularIndex, radialIndex + 1);
      const d = getIndex(angularIndex + 1, radialIndex + 1);

      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(positions, 3)
  );
  geometry.setAttribute(
    "aH",
    new BufferAttribute(normalizedHeights, 1)
  );
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  return geometry;
}

function createTerrainMaterials() {
  const uniforms = {
    valleyColor: uniform(new Color(TERRAIN_CONFIG.valleyColor)),
    midColor: uniform(new Color(TERRAIN_CONFIG.midColor)),
    crestColor: uniform(new Color(TERRAIN_CONFIG.crestColor)),
    midPoint: uniform(TERRAIN_CONFIG.midPoint),
    contrast: uniform(TERRAIN_CONFIG.contrast),
    crestThreshold: uniform(TERRAIN_CONFIG.crestThreshold),
    crestEmissive: uniform(TERRAIN_CONFIG.crestEmissive),
    hazeColor: uniform(new Color(TERRAIN_CONFIG.hazeColor)),
    hazeStrength: uniform(TERRAIN_CONFIG.hazeStrength),
    wireColor: uniform(new Color(TERRAIN_CONFIG.wireColor)),
    wirePulse: uniform(TERRAIN_CONFIG.wirePulse),
    wireHeightMin: uniform(TERRAIN_CONFIG.wireHeightMin),
    wireHeightSoft: uniform(TERRAIN_CONFIG.wireHeightSoft),
    wireHide: uniform(1),
  };
  const height = attribute("aH", "float");
  const lowerMix = pow(
    smoothstep(float(0), uniforms.midPoint, height),
    uniforms.contrast
  );
  const upperMix = pow(
    smoothstep(uniforms.midPoint, float(1), height),
    uniforms.contrast
  );
  const terrainColor = mix(
    mix(uniforms.valleyColor, uniforms.midColor, lowerMix),
    uniforms.crestColor,
    upperMix
  );
  const haze = smoothstep(float(0.5), float(0), height)
    .mul(uniforms.hazeStrength)
    .clamp(0, 1);
  const finalColor = mix(
    terrainColor,
    uniforms.hazeColor,
    haze
  );
  const crest = smoothstep(
    uniforms.crestThreshold,
    float(1),
    height
  );

  const solid = new MeshStandardNodeMaterial({
    side: DoubleSide,
    depthWrite: true,
  });
  solid.colorNode = finalColor;
  solid.emissiveNode = uniforms.crestColor
    .mul(crest)
    .mul(uniforms.crestEmissive);
  solid.roughness = 1;
  solid.metalness = 0;

  const wireThreshold = mix(
    uniforms.wireHeightMin,
    float(1),
    uniforms.wireHide
  );
  const wireMask = smoothstep(
    wireThreshold,
    wireThreshold.add(uniforms.wireHeightSoft),
    height
  );
  const pulse = sin(time.mul(1.2)).mul(0.3).add(0.5);
  const wireAlpha = wireMask
    .mul(uniforms.wirePulse)
    .mul(pulse)
    .clamp(0, 1);
  const wire = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    wireframe: true,
  });
  wire.positionNode = positionLocal.add(vec3(0, 0.05, 0));
  wire.colorNode = vec4(uniforms.wireColor, wireAlpha);

  return { solid, wire, uniforms };
}

function syncConfig(uniforms) {
  uniforms.valleyColor.value.set(TERRAIN_CONFIG.valleyColor);
  uniforms.midColor.value.set(TERRAIN_CONFIG.midColor);
  uniforms.crestColor.value.set(TERRAIN_CONFIG.crestColor);
  uniforms.midPoint.value = TERRAIN_CONFIG.midPoint;
  uniforms.contrast.value = TERRAIN_CONFIG.contrast;
  uniforms.crestThreshold.value = TERRAIN_CONFIG.crestThreshold;
  uniforms.crestEmissive.value = TERRAIN_CONFIG.crestEmissive;
  uniforms.hazeColor.value.set(TERRAIN_CONFIG.hazeColor);
  uniforms.hazeStrength.value = TERRAIN_CONFIG.hazeStrength;
  uniforms.wireColor.value.set(TERRAIN_CONFIG.wireColor);
  uniforms.wirePulse.value = TERRAIN_CONFIG.wirePulse;
  uniforms.wireHeightMin.value = TERRAIN_CONFIG.wireHeightMin;
  uniforms.wireHeightSoft.value = TERRAIN_CONFIG.wireHeightSoft;
}

export function Terrain({ introRuntime }) {
  const geometry = useMemo(createTerrainGeometry, []);
  const { solid, wire, uniforms } = useMemo(
    createTerrainMaterials,
    []
  );

  useEffect(
    () => () => {
      geometry.dispose();
      solid.dispose();
      wire.dispose();
    },
    [geometry, solid, wire]
  );

  useFrame(() => {
    syncConfig(uniforms);
    uniforms.wireHide.value = getIntroWireHide(
      getElapsed(introRuntime.now, introRuntime.startedAt)
    );
  });

  return (
    <group>
      <mesh geometry={geometry} material={solid} receiveShadow />
      <mesh geometry={geometry} material={wire} />
    </group>
  );
}
