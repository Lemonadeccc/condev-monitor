"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { useScroll } from "@react-three/drei";
import {
  AdditiveBlending,
  CanvasTexture,
  FrontSide,
  InstancedBufferAttribute,
  MathUtils,
  SRGBColorSpace,
  Vector3,
} from "three";
import {
  MeshBasicNodeMaterial,
  SpriteNodeMaterial,
} from "three/webgpu";
import {
  abs,
  float,
  hash,
  instanceIndex,
  instancedBufferAttribute,
  length,
  mix,
  mod,
  positionLocal,
  sin,
  smoothstep,
  texture,
  time,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { modelLabels } from "@/data/siteContent";
import {
  CAMERA_PATH,
  DUST_LAYER,
  getBeamIntensity,
  getBeamTip,
  getFogDensity,
  getGroundPulse,
  getIntroFogReveal,
} from "@/lib/sceneConfig";
import { getElapsed } from "./IntroClock";
import { HexSphere } from "./HexSphere";
import { ReflectiveGrid } from "./ReflectiveGrid";

function createDustPositionNode(count, size) {
  const positions = new Float32Array(count * 3);

  for (let index = 0; index < count; index += 1) {
    positions[index * 3] = (Math.random() - 0.5) * size;
    positions[index * 3 + 1] = (Math.random() - 0.5) * size;
    positions[index * 3 + 2] = (Math.random() - 0.5) * size;
  }

  const basePosition = instancedBufferAttribute(
    new InstancedBufferAttribute(positions, 3)
  );
  const halfSize = float(size / 2);
  const wrappedY = mod(
    basePosition.y.add(halfSize).add(time.mul(0.1)),
    float(size)
  ).sub(halfSize);
  const phase = hash(instanceIndex.add(11)).mul(6.283);
  const horizontalDrift = sin(time.add(phase)).mul(0.1);

  return vec3(
    basePosition.x.add(horizontalDrift),
    wrappedY,
    basePosition.z
  );
}

function createDustMaterial(count, size) {
  const positionNode = createDustPositionNode(count, size);
  const material = new SpriteNodeMaterial({
    transparent: true,
    depthWrite: false,
  });
  material.sizeAttenuation = true;
  const centeredUv = uv().sub(0.5);
  const radialDistance = length(centeredUv);
  const alpha = smoothstep(0.5, 0.2, radialDistance);
  const phase = hash(instanceIndex.add(500)).mul(6.283);
  const colorBlend = sin(time.mul(0.08).add(phase))
    .mul(0.5)
    .add(0.5);
  const color = mix(
    vec3(1, 1, 1),
    vec3(1, 0.1, 0.1),
    colorBlend
  );

  material.colorNode = vec4(color, 1);
  material.scaleNode = mix(
    float(0.03),
    float(0.1),
    hash(instanceIndex)
  );
  material.emissiveNode = color.mul(5.5).mul(alpha);
  material.opacityNode = alpha.mul(0.2);
  material.positionNode = positionNode;

  return material;
}

function DustField({ count = 2000, size = 10 }) {
  const ref = useRef(null);
  const camera = useThree((state) => state.camera);
  const material = useMemo(
    () => createDustMaterial(count, size),
    [count, size]
  );

  useEffect(() => {
    ref.current?.layers.set(DUST_LAYER);
    camera.layers.enable(DUST_LAYER);

    return () => {
      material.dispose();
    };
  }, [camera, material]);

  return (
    <sprite
      ref={ref}
      count={count}
      material={material}
      frustumCulled={false}
    />
  );
}

function GroundPulse({
  maxRadius = 26,
  speed = 0.25,
  width = 0.9,
}) {
  const scroll = useScroll();
  const { material, intensity } = useMemo(() => {
    const intensityNode = uniform(0);
    const radius = length(positionLocal.xy);
    const pulseRadius = time
      .mul(speed)
      .fract()
      .mul(maxRadius);
    const band = float(1).sub(
      smoothstep(0, width, abs(radius.sub(pulseRadius)))
    );
    const startFade = smoothstep(0, 2, pulseRadius);
    const edgeFade = float(1).sub(
      smoothstep(maxRadius * 0.6, maxRadius, radius)
    );
    const nodeMaterial = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });

    nodeMaterial.colorNode = vec3(1, 0.45, 0.2);
    nodeMaterial.opacityNode = band
      .mul(startFade)
      .mul(edgeFade)
      .mul(intensityNode);

    return {
      material: nodeMaterial,
      intensity: intensityNode,
    };
  }, [maxRadius, speed, width]);

  useEffect(() => () => material.dispose(), [material]);

  useFrame(() => {
    intensity.value = getGroundPulse(scroll.offset);
  });

  return (
    <mesh
      material={material}
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, 0.02, 0]}
    >
      <circleGeometry args={[maxRadius, 96]} />
    </mesh>
  );
}

function EnergyBeam({
  bottom = 1,
  top = 130,
  radius = 0.08,
}) {
  const scroll = useScroll();
  const height = top - bottom;
  const { material, tip, intensity } = useMemo(() => {
    const tipNode = uniform(0);
    const intensityNode = uniform(0);
    const normalizedY = positionLocal.y.div(height).add(0.5);
    const reveal = float(1).sub(
      smoothstep(
        tipNode.sub(0.02),
        tipNode.add(0.02),
        normalizedY
      )
    );
    const tipGlow = smoothstep(
      float(0.07),
      float(0),
      abs(normalizedY.sub(tipNode))
    );
    const pulse = sin(
      normalizedY
        .mul(7)
        .sub(time.mul(3))
        .mul(Math.PI)
    )
      .mul(0.5)
      .add(0.5);
    const baseFade = smoothstep(0, 0.04, normalizedY);
    const nodeMaterial = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });

    nodeMaterial.colorNode = vec3(1, 0.7, 0.4);
    nodeMaterial.opacityNode = reveal
      .mul(pulse.mul(0.4).add(0.4))
      .add(tipGlow.mul(1.6))
      .mul(baseFade)
      .mul(intensityNode);

    return {
      material: nodeMaterial,
      tip: tipNode,
      intensity: intensityNode,
    };
  }, [height]);

  useEffect(() => () => material.dispose(), [material]);

  useFrame(() => {
    tip.value = getBeamTip(scroll.offset);
    intensity.value = getBeamIntensity(scroll.offset);
  });

  return (
    <mesh material={material} position={[0, bottom + height / 2, 0]}>
      <cylinderGeometry
        args={[radius, radius, height, 12, 1, true]}
      />
    </mesh>
  );
}

function SceneFog({ introRuntime }) {
  const scene = useThree((state) => state.scene);

  useFrame(() => {
    if (!scene.fog) {
      return;
    }

    const reveal = getIntroFogReveal(
      getElapsed(
        introRuntime.now,
        introRuntime.fogStartedAt
      )
    );
    scene.fog.density = getFogDensity(reveal);
  });

  return null;
}

const LABEL_FONT = "IBM Plex Mono";
const LABEL_FONT_SIZE = 100;
const LABEL_COLOR = "#ffd9b0";
const LABEL_RADIUS = 3;
const LABEL_HEIGHT = 1;
const LABEL_LINE_HEIGHT = 1.35;
const LABEL_FADE_FRACTION = 0.32;

function createLabelCanvas(text, onReady) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");

  if (!context) {
    return null;
  }

  const font = `${LABEL_FONT_SIZE}px "${LABEL_FONT}", monospace`;
  context.font = font;

  const lines = text.split("\n");
  const padding = LABEL_FONT_SIZE * 0.5;
  const lineHeight = LABEL_FONT_SIZE * LABEL_LINE_HEIGHT;
  const lineWidths = lines.map(
    (line) => context.measureText(line).width
  );
  const width = Math.ceil(Math.max(...lineWidths) + padding * 2);
  const height = Math.ceil(
    lineHeight * lines.length + padding * 2
  );

  canvas.width = width;
  canvas.height = height;
  context.textAlign = "left";
  context.textBaseline = "middle";

  const drawText = () => {
    lines.forEach((line, index) => {
      const x = (width - lineWidths[index]) / 2;
      const y =
        padding + lineHeight * (index + 0.5);
      context.fillText(line, x, y);
    });
  };

  const canvasTexture = new CanvasTexture(canvas);
  canvasTexture.colorSpace = SRGBColorSpace;
  canvasTexture.anisotropy = 4;

  const textureNode = texture(canvasTexture);
  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    side: FrontSide,
  });
  material.colorNode = textureNode.rgb;
  material.opacityNode = textureNode.a;

  const draw = (reveal, conceal) => {
    context.clearRect(0, 0, width, height);
    const clipStart = conceal * width;
    const clipEnd = reveal * width;

    if (clipEnd > clipStart) {
      context.font = font;
      context.fillStyle = LABEL_COLOR;
      context.save();
      context.beginPath();
      context.rect(
        clipStart,
        0,
        clipEnd - clipStart,
        height
      );
      context.clip();
      drawText();
      context.restore();
    }

    canvasTexture.needsUpdate = true;
  };

  draw(0, 0);

  const result = {
    aspect: width / height,
    draw,
    material,
    texture: canvasTexture,
  };

  onReady(result);
  return result;
}

function WorldLabel({ label }) {
  const scroll = useScroll();
  const [labelTexture, setLabelTexture] = useState(null);
  const drawState = useRef({ reveal: -1, conceal: -1 });
  const { position, rotationY } = useMemo(() => {
    const midpoint = (label.start + label.end) / 2;
    const angle =
      CAMERA_PATH.startAngle +
      midpoint * CAMERA_PATH.turns * Math.PI * 2;
    const tangent = new Vector3(
      Math.cos(angle),
      0,
      -Math.sin(angle)
    );

    return {
      rotationY: angle,
      position: new Vector3(
        Math.sin(angle) * LABEL_RADIUS +
          tangent.x * label.offset,
        label.y,
        Math.cos(angle) * LABEL_RADIUS +
          tangent.z * label.offset
      ),
    };
  }, [label]);

  useEffect(() => {
    let disposed = false;
    let resource = null;
    const create = () => {
      if (disposed) {
        return;
      }

      resource = createLabelCanvas(label.text, (next) => {
        if (!disposed) {
          setLabelTexture(next);
        }
      });
    };

    if (document.fonts?.load) {
      document.fonts
        .load(`${LABEL_FONT_SIZE}px "${LABEL_FONT}"`)
        .then(create)
        .catch(create);
    } else {
      create();
    }

    return () => {
      disposed = true;
      resource?.texture.dispose();
      resource?.material.dispose();
    };
  }, [label.text]);

  useFrame(() => {
    if (!labelTexture) {
      return;
    }

    const progress = scroll.offset;
    const fadeLength =
      (label.end - label.start) * LABEL_FADE_FRACTION;
    const reveal = MathUtils.smoothstep(
      progress,
      label.start,
      label.start + fadeLength
    );
    const conceal = MathUtils.smoothstep(
      progress,
      label.end - fadeLength,
      label.end
    );

    if (
      reveal !== drawState.current.reveal ||
      conceal !== drawState.current.conceal
    ) {
      drawState.current.reveal = reveal;
      drawState.current.conceal = conceal;
      labelTexture.draw(reveal, conceal);
    }
  });

  if (!labelTexture) {
    return null;
  }

  return (
    <mesh
      position={position}
      rotation={[0, rotationY, 0]}
      material={labelTexture.material}
    >
      <planeGeometry
        args={[
          LABEL_HEIGHT * labelTexture.aspect,
          LABEL_HEIGHT,
        ]}
      />
    </mesh>
  );
}

export function SceneEffects({ introRuntime }) {
  return (
    <>
      <SceneFog introRuntime={introRuntime} />
      <DustField size={100} count={2500} />
      <GroundPulse />
      <EnergyBeam />
      {modelLabels.map((label) => (
        <WorldLabel key={label.text} label={label} />
      ))}
      <HexSphere />
      <ReflectiveGrid />
    </>
  );
}
