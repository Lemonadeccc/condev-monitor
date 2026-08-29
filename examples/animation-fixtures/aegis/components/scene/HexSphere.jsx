"use client";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
} from "react";
import { useFrame } from "@react-three/fiber";
import { useScroll } from "@react-three/drei";
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Vector3,
} from "three";
import { MeshStandardNodeMaterial } from "three/webgpu";
import {
  abs,
  attribute,
  dot,
  float,
  fwidth,
  max,
  mx_noise_float,
  normalView,
  positionLocal,
  positionViewDirection,
  pow,
  smoothstep,
  time,
  uniform,
  vec3,
  vec4,
} from "three/tsl";
import {
  HEX_SPHERE_CONFIG,
  getSphereReveal,
} from "@/lib/sceneConfig";

const PHI = (1 + Math.sqrt(5)) / 2;
const ICOSAHEDRON_VERTICES = [
  [-1, PHI, 0],
  [1, PHI, 0],
  [-1, -PHI, 0],
  [1, -PHI, 0],
  [0, -1, PHI],
  [0, 1, PHI],
  [0, -1, -PHI],
  [0, 1, -PHI],
  [PHI, 0, -1],
  [PHI, 0, 1],
  [-PHI, 0, -1],
  [-PHI, 0, 1],
];
const ICOSAHEDRON_FACES = [
  [0, 11, 5],
  [0, 5, 1],
  [0, 1, 7],
  [0, 7, 10],
  [0, 10, 11],
  [1, 5, 9],
  [5, 11, 4],
  [11, 10, 2],
  [10, 7, 6],
  [7, 1, 8],
  [3, 9, 4],
  [3, 4, 2],
  [3, 2, 6],
  [3, 6, 8],
  [3, 8, 9],
  [4, 9, 5],
  [2, 4, 11],
  [6, 2, 10],
  [8, 6, 7],
  [9, 8, 1],
];

function seededRandom(seed) {
  const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return value - Math.floor(value);
}

function getTangent(normal) {
  const x = Math.abs(normal.x);
  const y = Math.abs(normal.y);
  const z = Math.abs(normal.z);
  const axis =
    x < y && x < z
      ? new Vector3(1, 0, 0)
      : y < z
        ? new Vector3(0, 1, 0)
        : new Vector3(0, 0, 1);

  return axis.cross(normal).normalize();
}

function createHexSphereGeometry({
  frequency = 6,
  radius = 1,
} = {}) {
  const subdivisions = Math.max(1, Math.floor(frequency));
  const vertices = [];
  const vertexMap = new Map();
  const addVertex = (point) => {
    const normalized = point.clone().normalize();
    const key = `${normalized.x.toFixed(5)},${normalized.y.toFixed(
      5
    )},${normalized.z.toFixed(5)}`;
    let index = vertexMap.get(key);

    if (index === undefined) {
      index = vertices.length;
      vertices.push(normalized);
      vertexMap.set(key, index);
    }

    return index;
  };
  const triangles = [];

  for (const [aIndex, bIndex, cIndex] of ICOSAHEDRON_FACES) {
    const a = new Vector3(...ICOSAHEDRON_VERTICES[aIndex]);
    const b = new Vector3(...ICOSAHEDRON_VERTICES[bIndex]);
    const c = new Vector3(...ICOSAHEDRON_VERTICES[cIndex]);
    const rows = [];

    for (let row = 0; row <= subdivisions; row += 1) {
      rows[row] = [];

      for (
        let column = 0;
        column <= subdivisions - row;
        column += 1
      ) {
        const aWeight =
          (subdivisions - row - column) / subdivisions;
        const bWeight = column / subdivisions;
        const cWeight = row / subdivisions;
        const point = new Vector3()
          .addScaledVector(a, aWeight)
          .addScaledVector(b, bWeight)
          .addScaledVector(c, cWeight);

        rows[row][column] = addVertex(point);
      }
    }

    for (let row = 0; row < subdivisions; row += 1) {
      for (
        let column = 0;
        column < subdivisions - row;
        column += 1
      ) {
        triangles.push([
          rows[row][column],
          rows[row][column + 1],
          rows[row + 1][column],
        ]);

        if (column < subdivisions - row - 1) {
          triangles.push([
            rows[row][column + 1],
            rows[row + 1][column + 1],
            rows[row + 1][column],
          ]);
        }
      }
    }
  }

  const faceCenters = triangles.map(([a, b, c]) =>
    vertices[a]
      .clone()
      .add(vertices[b])
      .add(vertices[c])
      .normalize()
  );
  const adjacency = vertices.map(() => []);

  triangles.forEach((triangle, triangleIndex) => {
    for (const vertexIndex of triangle) {
      adjacency[vertexIndex].push(triangleIndex);
    }
  });

  const positions = [];
  const normals = [];
  const edges = [];
  const cellRandoms = [];
  const cellHeights = [];
  const pushVertex = (
    point,
    normal,
    edge,
    cellRandom,
    cellHeight
  ) => {
    positions.push(
      point.x * radius,
      point.y * radius,
      point.z * radius
    );
    normals.push(normal.x, normal.y, normal.z);
    edges.push(edge);
    cellRandoms.push(cellRandom);
    cellHeights.push(cellHeight);
  };

  vertices.forEach((center, cellIndex) => {
    const adjacentFaces = adjacency[cellIndex];

    if (adjacentFaces.length < 3) {
      return;
    }

    const normal = center.clone().normalize();
    const tangent = getTangent(normal);
    const bitangent = normal.clone().cross(tangent);
    const ring = adjacentFaces
      .map((faceIndex) => {
        const offset = faceCenters[faceIndex]
          .clone()
          .sub(center);

        return {
          point: faceCenters[faceIndex],
          angle: Math.atan2(
            offset.dot(bitangent),
            offset.dot(tangent)
          ),
        };
      })
      .sort((a, b) => a.angle - b.angle)
      .map((entry) => entry.point);
    const random = seededRandom(cellIndex);
    const cellHeight = center.y * radius;

    for (let index = 0; index < ring.length; index += 1) {
      let current = ring[index];
      let next = ring[(index + 1) % ring.length];

      if (
        current
          .clone()
          .sub(center)
          .cross(next.clone().sub(center))
          .dot(normal) < 0
      ) {
        [current, next] = [next, current];
      }

      pushVertex(center, normal, 1, random, cellHeight);
      pushVertex(current, normal, 0, random, cellHeight);
      pushVertex(next, normal, 0, random, cellHeight);
    }
  });

  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(new Float32Array(positions), 3)
  );
  geometry.setAttribute(
    "normal",
    new BufferAttribute(new Float32Array(normals), 3)
  );
  geometry.setAttribute(
    "aEdge",
    new BufferAttribute(new Float32Array(edges), 1)
  );
  geometry.setAttribute(
    "aCellRandom",
    new BufferAttribute(new Float32Array(cellRandoms), 1)
  );
  geometry.setAttribute(
    "aCellY",
    new BufferAttribute(new Float32Array(cellHeights), 1)
  );
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  return geometry;
}

function createHexSphereMaterial() {
  const config = HEX_SPHERE_CONFIG;
  const uniforms = {
    progress: uniform(0.5),
    cellFade: uniform(config.cellFade),
    cellJitter: uniform(config.cellJitter),
    edgeColor: uniform(new Color(config.edgeColor)),
    edgeIntensity: uniform(config.edgeIntensity),
    edgeWidth: uniform(config.edgeWidth),
    edgeFlash: uniform(config.edgeFlash),
    bloomStrength: uniform(config.bloomStrength),
    edgeNoiseScale: uniform(config.edgeNoiseScale),
    edgeNoiseSpeed: uniform(config.edgeNoiseSpeed),
    edgeNoiseAmount: uniform(config.edgeNoiseAmount),
    cellGap: uniform(config.cellGap),
    hexEdgeColor: uniform(new Color(config.hexEdgeColor)),
    hexEdgeIntensity: uniform(config.hexEdgeIntensity),
    hexEdgeWidth: uniform(config.hexEdgeWidth),
    hexEdgeBloom: uniform(config.hexEdgeBloom),
    bodyColor: uniform(new Color(config.bodyColor)),
    fillOpacity: uniform(config.fillOpacity),
    minVisibility: uniform(config.minVisibility),
    energyColor: uniform(new Color(config.energyColor)),
    energyIntensity: uniform(config.energyIntensity),
    energyScale: uniform(config.energyScale),
    energySpeed: uniform(config.energySpeed),
    energyContrast: uniform(config.energyContrast),
    baseColor: uniform(new Color(config.baseColor)),
    baseOpacity: uniform(config.baseOpacity),
    baseRimStrength: uniform(config.baseRimStrength),
    baseRimPower: uniform(config.baseRimPower),
    baseEmissive: uniform(config.baseEmissive),
    boundsMinY: uniform(-1),
    boundsHeight: uniform(3),
  };
  const edgeAttribute = attribute("aEdge", "float");
  const cellRandom = attribute("aCellRandom", "float");
  const cellHeight = attribute("aCellY", "float");
  const normalizedHeight = positionLocal.y
    .sub(uniforms.boundsMinY)
    .div(uniforms.boundsHeight)
    .add(
      mx_noise_float(
        positionLocal
          .add(
            vec3(
              time.mul(uniforms.edgeNoiseSpeed).mul(8),
              0,
              0
            )
          )
          .mul(uniforms.edgeNoiseScale)
      ).mul(uniforms.edgeNoiseAmount)
    );
  const normalizedCellHeight = cellHeight
    .sub(uniforms.boundsMinY)
    .div(uniforms.boundsHeight)
    .add(cellRandom.sub(0.5).mul(uniforms.cellJitter));
  const coordinate = normalizedHeight;
  const revealFront = float(1.15).sub(
    uniforms.progress.mul(1.3)
  );
  const signedDistance = coordinate.sub(revealFront);
  const revealed = smoothstep(
    float(0),
    uniforms.cellFade,
    signedDistance
  );
  const ghost = float(1).sub(revealed);
  const edgeBand = smoothstep(
    uniforms.edgeWidth,
    float(0),
    abs(signedDistance)
  );
  const edgeDerivative = fwidth(edgeAttribute);
  const cellMask = smoothstep(
    uniforms.cellGap.sub(edgeDerivative),
    uniforms.cellGap.add(edgeDerivative),
    edgeAttribute
  );
  const cellBorder = cellMask
    .mul(float(1).sub(cellMask))
    .mul(4);
  const energyPosition = positionLocal
    .mul(uniforms.energyScale)
    .add(vec3(0, time.mul(uniforms.energySpeed).negate(), 0));
  const energyA = mx_noise_float(energyPosition);
  const energyB = mx_noise_float(
    energyPosition
      .mul(2.1)
      .add(
        vec3(
          time.mul(uniforms.energySpeed).mul(1.7),
          0,
          0
        )
      )
  );
  const energy = pow(
    energyA
      .mul(0.6)
      .add(energyB.mul(0.4))
      .mul(0.5)
      .add(0.5)
      .clamp(0, 1),
    uniforms.energyContrast
  );

  const hexEdge = smoothstep(
    uniforms.hexEdgeWidth,
    float(0),
    edgeAttribute
  )
    .mul(energy)
    .mul(uniforms.hexEdgeIntensity);
  const hexEdgeColor = uniforms.hexEdgeColor.mul(hexEdge);
  const energyColor = uniforms.energyColor
    .mul(energy)
    .mul(uniforms.energyIntensity)
    .mul(cellMask);
  const bodyColor = uniforms.bodyColor
    .mul(cellMask)
    .mul(uniforms.fillOpacity)
    .mul(energy);
  const bodyAlpha = max(
    max(hexEdge, energy.mul(cellMask)),
    cellMask.mul(uniforms.minVisibility)
  ).clamp(0, 1);
  const bodyEmissive = energyColor.add(
    hexEdgeColor.mul(uniforms.hexEdgeBloom)
  );

  const edgeCellMask = max(
    cellBorder,
    cellMask.mul(uniforms.edgeFlash)
  );
  const scanEdge = edgeBand
    .mul(edgeCellMask)
    .mul(energy);
  const scanColor = uniforms.edgeColor
    .mul(scanEdge)
    .mul(uniforms.edgeIntensity);
  const scanEmissive = uniforms.edgeColor
    .mul(scanEdge)
    .mul(uniforms.bloomStrength);
  const scanAlpha = scanEdge.mul(uniforms.edgeIntensity);

  const facing = dot(
    normalView,
    positionViewDirection
  ).clamp(0, 1);
  const rim = pow(
    float(1).sub(facing),
    uniforms.baseRimPower
  ).mul(uniforms.baseRimStrength);
  const baseStrength = max(rim, cellBorder).mul(
    uniforms.baseOpacity
  );
  const baseColor = uniforms.baseColor.mul(baseStrength);
  const baseEmissive = uniforms.baseColor
    .mul(cellBorder)
    .mul(uniforms.baseEmissive);

  const color = bodyColor
    .add(energyColor)
    .add(hexEdgeColor)
    .mul(revealed)
    .add(baseColor.mul(ghost))
    .add(scanColor);
  const alpha = max(
    max(bodyAlpha.mul(revealed), baseStrength.mul(ghost)),
    scanAlpha
  );
  const emissive = scanEmissive
    .add(bodyEmissive.mul(revealed))
    .add(baseEmissive.mul(ghost));

  const material = new MeshStandardNodeMaterial({
    transparent: true,
    depthWrite: false,
  });
  material.colorNode = vec4(color, alpha);
  material.emissiveNode = emissive;

  return {
    material,
    uniforms,
    normalizedCellHeight,
  };
}

export function HexSphere() {
  const scroll = useScroll();
  const geometry = useMemo(
    () =>
      createHexSphereGeometry({
        frequency: HEX_SPHERE_CONFIG.frequency,
        radius: HEX_SPHERE_CONFIG.radius,
      }),
    []
  );
  const { material, uniforms } = useMemo(
    createHexSphereMaterial,
    []
  );

  useLayoutEffect(() => {
    const bounds = geometry.boundingBox;

    if (bounds) {
      uniforms.boundsMinY.value = bounds.min.y;
      uniforms.boundsHeight.value = Math.max(
        bounds.max.y - bounds.min.y,
        0.000001
      );
    }
  }, [geometry, uniforms]);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material]
  );

  useFrame(() => {
    uniforms.progress.value = getSphereReveal(scroll.offset);
  });

  return (
    <mesh
      geometry={geometry}
      material={material}
      scale={HEX_SPHERE_CONFIG.scale}
    />
  );
}
