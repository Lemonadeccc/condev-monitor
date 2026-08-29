"use client";

import { useEffect } from "react";
import {
  ANTENNA_CONFIG,
  CAMERA_PATH,
  FINAL_CAMERA,
  POST_CONFIG,
  TERRAIN_CONFIG,
} from "@/lib/sceneConfig";

function addCameraControls(gui) {
  const folder = gui.addFolder("Camera");
  folder.add(CAMERA_PATH, "turns", 0, 3, 0.01).name("Turns");
  folder
    .add(CAMERA_PATH, "radiusNear", 2, 20, 0.1)
    .name("Near radius");
  folder
    .add(CAMERA_PATH, "radiusMid", 3, 20, 0.1)
    .name("Mid radius");
  folder
    .add(CAMERA_PATH, "radiusFar", 40, 320, 1)
    .name("Far radius");
  folder.add(CAMERA_PATH, "yBottom", 0, 12, 0.1).name("Start Y");
  folder.add(CAMERA_PATH, "yTop", 4, 20, 0.1).name("Top Y");
  folder.add(CAMERA_PATH, "roll", -0.3, 0.3, 0.005).name("Roll");
  folder
    .add(FINAL_CAMERA, "sideShift", -250, 250, 1)
    .name("Final side shift");
  folder
    .add(FINAL_CAMERA, "radiusEnd", 60, 320, 1)
    .name("Final radius");
  folder
    .add(FINAL_CAMERA, "yEnd", 5, 120, 0.5)
    .name("Final Y");
  folder
    .add(FINAL_CAMERA, "driftSpeed", -0.1, 0.1, 0.001)
    .name("Final drift");
}

function addAntennaControls(gui) {
  const folder = gui.addFolder("Antenna");
  folder.addColor(ANTENNA_CONFIG, "edgeColor").name("Edge color");
  folder
    .add(ANTENNA_CONFIG, "edgeIntensity", 0, 20, 0.01)
    .name("Edge intensity");
  folder
    .add(ANTENNA_CONFIG, "edgeWidth", 0, 0.2, 0.001)
    .name("Edge width");
  folder
    .add(ANTENNA_CONFIG, "edgeNoiseScale", 0, 20, 0.01)
    .name("Noise scale");
  folder
    .add(ANTENNA_CONFIG, "edgeNoiseAmount", 0, 1, 0.01)
    .name("Noise amount");
  folder
    .add(ANTENNA_CONFIG, "bloomStrength", 0, 20, 0.01)
    .name("Emissive");
  folder.addColor(ANTENNA_CONFIG, "bodyColor").name("Body color");
  folder.addColor(ANTENNA_CONFIG, "baseColor").name("Ghost color");
  folder
    .add(ANTENNA_CONFIG, "baseOpacity", 0, 1, 0.01)
    .name("Ghost opacity");
}

function addPostControls(gui) {
  const bloomFolder = gui.addFolder("Bloom");
  bloomFolder
    .add(POST_CONFIG, "bloomStrength", 0, 5, 0.01)
    .name("Strength");
  bloomFolder
    .add(POST_CONFIG, "bloomRadius", 0, 1, 0.01)
    .name("Radius");
  bloomFolder
    .add(POST_CONFIG, "bloomThreshold", 0, 2, 0.01)
    .name("Threshold");

  const lensFolder = gui.addFolder("Lens");
  lensFolder
    .add(POST_CONFIG, "caStrength", 0, 0.05, 0.001)
    .name("Chromatic");
  lensFolder
    .add(POST_CONFIG, "vignetteSmoothing", 0, 1, 0.01)
    .name("Vignette");
  lensFolder
    .add(POST_CONFIG, "vignetteExponent", 0.2, 6, 0.05)
    .name("Hardness");
  lensFolder
    .add(POST_CONFIG, "grainIntensity", 0, 0.2, 0.001)
    .name("Grain");
  lensFolder
    .add(POST_CONFIG, "grainScale", 0.2, 8, 0.1)
    .name("Grain scale");
  lensFolder
    .add(POST_CONFIG, "grainFps", 1, 60, 1)
    .name("Grain FPS");
}

function addTerrainControls(gui) {
  const folder = gui.addFolder("Terrain");
  folder.addColor(TERRAIN_CONFIG, "valleyColor").name("Valley");
  folder.addColor(TERRAIN_CONFIG, "midColor").name("Mid");
  folder.addColor(TERRAIN_CONFIG, "crestColor").name("Crest");
  folder
    .add(TERRAIN_CONFIG, "crestThreshold", 0, 1, 0.01)
    .name("Crest threshold");
  folder
    .add(TERRAIN_CONFIG, "crestEmissive", 0, 5, 0.01)
    .name("Crest emissive");
  folder.addColor(TERRAIN_CONFIG, "wireColor").name("Wire");
  folder
    .add(TERRAIN_CONFIG, "wirePulse", 0, 4, 0.01)
    .name("Wire intensity");
}

export function DebugGui() {
  useEffect(() => {
    let disposed = false;
    let gui = null;
    let visible = false;

    const handleKeyDown = (event) => {
      if (
        event.key.toLowerCase() !== "g" ||
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      visible = !visible;

      if (visible) {
        gui?.show();
      } else {
        gui?.hide();
      }
    };

    import("lil-gui").then(({ default: GUI }) => {
      if (disposed) {
        return;
      }

      gui = new GUI({ title: "AEGIS / Bundle controls" });
      gui.close();
      gui.hide();
      addCameraControls(gui);
      addAntennaControls(gui);
      addPostControls(gui);
      addTerrainControls(gui);
      window.addEventListener("keydown", handleKeyDown);
    });

    return () => {
      disposed = true;
      window.removeEventListener("keydown", handleKeyDown);
      gui?.destroy();
    };
  }, []);

  return null;
}
