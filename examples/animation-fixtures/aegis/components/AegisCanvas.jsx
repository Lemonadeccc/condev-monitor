"use client";

import { Suspense } from "react";
import {
  CondevAnimationProfiler,
} from "@condev-monitor/react/animation";
import { CondevR3FObserver } from "@condev-monitor/react/animation/r3f";
import { Canvas, useThree } from "@react-three/fiber";
import { ScrollControls } from "@react-three/drei";
import { ACESFilmicToneMapping } from "three";
import { AegisScene } from "./scene/AegisScene";
import { condevClient } from "@/instrumentation-client";
import { useReducedMotion } from "@/lib/useReducedMotion";

const rendererBackends = new WeakMap();

async function createRenderer(properties) {
  const { WebGPURenderer } = await import("three/webgpu");
  const webGpuAvailable =
    typeof navigator !== "undefined" && navigator.gpu !== undefined;
  let renderer;

  try {
    renderer = new WebGPURenderer({
      ...properties,
      antialias: true,
      forceWebGL: !webGpuAvailable,
    });
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.3;
    await renderer.init();
    rendererBackends.set(
      renderer,
      webGpuAvailable ? "webgpu" : "webgl2"
    );
  } catch (error) {
    console.warn(
      "[AEGIS] WebGPU initialization failed; using Three's WebGL 2 node backend.",
      error
    );
    renderer?.dispose();
    renderer = new WebGPURenderer({
      ...properties,
      antialias: true,
      forceWebGL: true,
    });
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.3;
    await renderer.init();
    rendererBackends.set(renderer, "webgl2");
  }

  return renderer;
}

function AegisR3FObserver() {
  const renderer = useThree((state) => state.gl);

  if (rendererBackends.get(renderer) !== "webgl2") {
    return null;
  }

  return (
    <CondevR3FObserver
      backend="webgl2"
      client={condevClient}
    />
  );
}

export function AegisCanvas({
  introStarted,
  onBootState,
  onReady,
}) {
  const reduceMotion = useReducedMotion();

  return (
    <CondevAnimationProfiler client={condevClient}>
      <div className="scene-canvas">
        <Canvas
          camera={{
            position: [4, 4, 13],
            far: 500,
            fov: 80,
            near: 0.1,
          }}
          dpr={1}
          fallback={
            <div className="scene-fallback">
              Unable to initialize the 3D renderer.
            </div>
          }
          gl={createRenderer}
          shadows="soft"
        >
          <AegisR3FObserver />
          <ScrollControls
            damping={0.25}
            pages={5}
          >
            <Suspense fallback={null}>
              <AegisScene
                introStarted={introStarted}
                onBootState={onBootState}
                onReady={onReady}
                reduceMotion={reduceMotion}
              />
            </Suspense>
          </ScrollControls>
        </Canvas>
      </div>
    </CondevAnimationProfiler>
  );
}
