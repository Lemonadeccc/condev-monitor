"use client";

import { useEffect, useMemo } from "react";
import {
  Color,
  DoubleSide,
  NormalBlending,
  PlaneGeometry,
} from "three";
import { MeshBasicNodeMaterial } from "three/webgpu";
import {
  Fn,
  Loop,
  abs,
  convertToTexture,
  cos,
  degrees,
  float,
  fract,
  length,
  max,
  min,
  mix,
  positionLocal,
  pow,
  premultiplyAlpha,
  rand,
  reflector,
  remapClamp,
  sin,
  smoothstep,
  time,
  uniform,
  unpremultiplyAlpha,
  uv,
  vec2,
  vec4,
} from "three/tsl";
import {
  DUST_LAYER,
  GRID_CONFIG,
} from "@/lib/sceneConfig";

function createRadialBlur(inputNode) {
  const inputTexture = convertToTexture(inputNode);

  return Fn(() => {
    const repeats = float(45);
    const radius = float(0.005);
    const coordinates = inputTexture.uvNode || uv();
    const result = vec4(0).toVar();

    Loop(
      {
        start: 0,
        end: repeats,
        type: "float",
      },
      ({ i }) => {
        const angle = degrees(i.div(repeats).mul(360));
        const direction = vec2(cos(angle), sin(angle)).mul(
          rand(vec2(i, coordinates.x.add(coordinates.y))).add(
            radius
          )
        );
        const sampleCoordinates = coordinates.add(
          direction.mul(radius)
        );

        result.addAssign(
          premultiplyAlpha(inputTexture.sample(sampleCoordinates))
        );
      }
    );

    result.divAssign(repeats);
    return unpremultiplyAlpha(result);
  })();
}

function createGridMaterial() {
  const uniforms = {
    groundColor: uniform(new Color(GRID_CONFIG.groundColor)),
    lineColor: uniform(new Color(GRID_CONFIG.lineColor)),
    crossColor: uniform(new Color(GRID_CONFIG.crossColor)),
    groundOpacity: uniform(GRID_CONFIG.groundOpacity),
    lineOpacity: uniform(GRID_CONFIG.lineOpacity),
    crossOpacity: uniform(GRID_CONFIG.crossOpacity),
    fadeStart: uniform(GRID_CONFIG.fadeStart),
    fadeEnd: uniform(GRID_CONFIG.fadeEnd),
    scale: uniform(GRID_CONFIG.scale),
    lineDensity: uniform(GRID_CONFIG.lineDensity),
    lineThickness: uniform(GRID_CONFIG.lineThickness),
    crossDensity: uniform(GRID_CONFIG.crossDensity),
    crossThickness: uniform(GRID_CONFIG.crossThickness),
    crossSize: uniform(GRID_CONFIG.crossSize),
    scanSpeed: uniform(GRID_CONFIG.scanSpeed),
    scanFrequency: uniform(GRID_CONFIG.scanFrequency),
    scanSharpness: uniform(GRID_CONFIG.scanSharpness),
    scanFloor: uniform(GRID_CONFIG.scanFloor),
    scanPeak: uniform(GRID_CONFIG.scanPeak),
    reflection: uniform(GRID_CONFIG.reflection),
  };
  const reflectionNode = reflector({
    resolutionScale: 1,
    depth: true,
    bounces: false,
  });

  reflectionNode.target.rotateX(-Math.PI / 2);

  const getVirtualCamera =
    reflectionNode.reflector.getVirtualCamera.bind(
      reflectionNode.reflector
    );

  reflectionNode.reflector.getVirtualCamera = (camera) => {
    const virtualCamera = getVirtualCamera(camera);
    virtualCamera.layers.disable(DUST_LAYER);
    return virtualCamera;
  };

  const reflectionDepth = reflectionNode.getDepthNode().r;
  const blurredReflection = createRadialBlur(reflectionNode);
  const blurMix = remapClamp(
    blurredReflection.a.mul(reflectionDepth),
    0,
    0.1
  );
  const reflectionColor = mix(
    reflectionNode.rgb,
    blurredReflection.rgb,
    blurMix
  ).mul(uniforms.reflection);
  const position = vec2(positionLocal.x, positionLocal.z);
  const centerMask = smoothstep(
    float(0),
    float(0.4),
    max(abs(position.x), abs(position.y))
  );
  const distanceFade = smoothstep(
    uniforms.fadeEnd,
    uniforms.fadeStart,
    length(position)
  );

  const crossCoordinates = fract(
    position.mul(uniforms.crossDensity).mul(uniforms.scale)
  ).sub(0.5);
  const crossDiagonal = min(
    abs(crossCoordinates.x.sub(crossCoordinates.y)),
    abs(crossCoordinates.x.add(crossCoordinates.y))
  );
  const crossExtent = max(
    abs(crossCoordinates.x),
    abs(crossCoordinates.y)
  );
  const cross = smoothstep(
    uniforms.crossThickness,
    float(0),
    crossDiagonal
  ).mul(
    smoothstep(
      uniforms.crossSize,
      uniforms.crossSize.sub(0.02),
      crossExtent
    )
  );

  const lineCoordinates = fract(
    position.mul(uniforms.lineDensity).mul(uniforms.scale)
  ).sub(0.5);
  const line = smoothstep(
    uniforms.lineThickness,
    float(0),
    min(abs(lineCoordinates.x), abs(lineCoordinates.y))
  );
  const scanPosition = position.y
    .mul(uniforms.scanFrequency)
    .sub(time.mul(uniforms.scanSpeed));
  const scanWave = sin(scanPosition.mul(Math.PI * 2))
    .mul(0.5)
    .add(0.5);
  const scanIntensity = mix(
    uniforms.scanFloor,
    uniforms.scanPeak,
    pow(scanWave, uniforms.scanSharpness)
  );
  const lineStrength = line
    .mul(centerMask)
    .mul(uniforms.lineOpacity)
    .mul(scanIntensity.clamp(0.5, 1.5));
  const crossStrength = cross
    .mul(centerMask)
    .mul(uniforms.crossOpacity)
    .mul(scanIntensity);
  const baseColor = reflectionColor.add(uniforms.groundColor);
  const finalColor = mix(
    mix(
      baseColor,
      uniforms.lineColor,
      lineStrength.clamp(0, 1)
    ),
    uniforms.crossColor,
    crossStrength.clamp(0, 1)
  );
  const detailStrength = max(lineStrength, crossStrength);
  const alpha = max(
    uniforms.groundOpacity,
    detailStrength
  )
    .mul(distanceFade)
    .clamp(0, 1);

  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: NormalBlending,
  });
  material.colorNode = vec4(finalColor, alpha);

  return { material, reflectionNode, uniforms };
}

export function ReflectiveGrid() {
  const geometry = useMemo(() => {
    const plane = new PlaneGeometry(
      GRID_CONFIG.size,
      GRID_CONFIG.size,
      1,
      1
    );
    plane.rotateX(-Math.PI / 2);
    return plane;
  }, []);
  const { material, reflectionNode } = useMemo(
    createGridMaterial,
    []
  );

  useEffect(() => {
    return () => {
      geometry.dispose();
      material.dispose();
      reflectionNode.dispose();
    };
  }, [geometry, material, reflectionNode]);

  return (
    <>
      <primitive
        object={reflectionNode.target}
        position={[0, -0.01, 0]}
      />
      <mesh
        geometry={geometry}
        material={material}
        position={[0, -0.01, 0]}
        renderOrder={-1}
      />
    </>
  );
}
