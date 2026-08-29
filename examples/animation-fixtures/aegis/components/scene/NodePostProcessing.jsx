"use client";

import { useEffect, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { RenderPipeline } from "three/webgpu";
import {
  Fn,
  convertToTexture,
  dot,
  float,
  floor,
  fract,
  length,
  pass,
  pow,
  sin,
  smoothstep,
  time,
  uniform,
  uv,
  vec2,
  vec4,
} from "three/tsl";
import { bloom } from "three/examples/jsm/tsl/display/BloomNode.js";
import { POST_CONFIG } from "@/lib/sceneConfig";

function chromaticAberration(inputNode, strengthNode) {
  const inputTexture = convertToTexture(inputNode);

  return Fn(() => {
    const coordinates = uv().toVar();
    const centered = coordinates.sub(vec2(0.5)).toVar();
    const radialDistance = length(centered).toVar();
    const offset = centered
      .mul(strengthNode)
      .mul(radialDistance)
      .toVar();
    const redSample = inputTexture.sample(
      coordinates.add(offset)
    );
    const centerSample = inputTexture.sample(coordinates);
    const blueSample = inputTexture.sample(
      coordinates.sub(offset)
    );

    return vec4(
      redSample.r,
      centerSample.g,
      blueSample.b,
      centerSample.a
    );
  })();
}

function vignette(inputNode, smoothingNode, exponentNode) {
  const inputTexture = convertToTexture(inputNode);

  return Fn(() => {
    const coordinates = uv().toVar();
    const centered = coordinates.sub(0.5).toVar();
    const falloff = smoothstep(
      smoothingNode,
      float(1),
      length(centered)
    ).oneMinus();
    const vignetteStrength = pow(
      falloff,
      exponentNode
    ).toVar();

    return inputTexture
      .sample(coordinates)
      .mul(vignetteStrength);
  })();
}

function grain(
  inputNode,
  intensityNode,
  scaleNode,
  timeNode
) {
  const inputTexture = convertToTexture(inputNode);

  return Fn(() => {
    const coordinates = uv().toVar();
    const noiseCoordinates = coordinates
      .mul(scaleNode)
      .add(timeNode)
      .toVar();
    const noise = fract(
      sin(dot(noiseCoordinates, vec2(12.9898, 78.233))).mul(
        43758.5453123
      )
    )
      .sub(0.5)
      .mul(intensityNode)
      .toVar();

    return inputTexture.sample(coordinates).add(noise);
  })();
}

function createPipeline(renderer, scene, camera) {
  const renderPipeline = new RenderPipeline(
    renderer,
    vec4(0, 0, 0, 1)
  );
  const scenePass = pass(scene, camera);
  const sceneColor = scenePass.getTextureNode("output");
  const bloomNode = bloom(
    sceneColor,
    POST_CONFIG.bloomStrength,
    POST_CONFIG.bloomRadius,
    POST_CONFIG.bloomThreshold
  );
  const combined = convertToTexture(sceneColor.add(bloomNode));
  const caStrength = uniform(POST_CONFIG.caStrength);
  const aberrated = convertToTexture(
    chromaticAberration(combined, caStrength)
  );
  const vignetteSmoothing = uniform(
    POST_CONFIG.vignetteSmoothing
  );
  const vignetteExponent = uniform(
    POST_CONFIG.vignetteExponent
  );
  const vignetted = convertToTexture(
    vignette(
      aberrated,
      vignetteSmoothing,
      vignetteExponent
    )
  );
  const grainIntensity = uniform(POST_CONFIG.grainIntensity);
  const grainScale = uniform(POST_CONFIG.grainScale);
  const grainFps = uniform(POST_CONFIG.grainFps);
  const steppedTime = floor(time.mul(grainFps)).div(grainFps);

  renderPipeline.outputNode = grain(
    vignetted,
    grainIntensity,
    grainScale,
    steppedTime
  );
  renderPipeline.needsUpdate = true;

  return {
    bloomNode,
    caStrength,
    grainFps,
    grainIntensity,
    grainScale,
    renderPipeline,
    scenePass,
    vignetteExponent,
    vignetteSmoothing,
  };
}

export function NodePostProcessing() {
  const { camera, gl, scene } = useThree();
  const pipeline = useMemo(
    () => createPipeline(gl, scene, camera),
    [camera, gl, scene]
  );

  useEffect(
    () => () => {
      pipeline.bloomNode.dispose?.();
      pipeline.scenePass.dispose?.();
      pipeline.renderPipeline.dispose();
    },
    [pipeline]
  );

  useFrame(() => {
    pipeline.bloomNode.strength.value =
      POST_CONFIG.bloomStrength;
    pipeline.bloomNode.radius.value = POST_CONFIG.bloomRadius;
    pipeline.bloomNode.threshold.value =
      POST_CONFIG.bloomThreshold;
    pipeline.caStrength.value = POST_CONFIG.caStrength;
    pipeline.vignetteSmoothing.value =
      POST_CONFIG.vignetteSmoothing;
    pipeline.vignetteExponent.value =
      POST_CONFIG.vignetteExponent;
    pipeline.grainIntensity.value =
      POST_CONFIG.grainIntensity;
    pipeline.grainScale.value = POST_CONFIG.grainScale;
    pipeline.grainFps.value = POST_CONFIG.grainFps;
    pipeline.renderPipeline.render();
  }, 1);

  return null;
}
