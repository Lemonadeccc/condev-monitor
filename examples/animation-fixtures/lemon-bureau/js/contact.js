/**
 * contact.js
 *
 * Three.js rendering + custom 3D physics in LOCAL cube space.
 * Uses Line2 / LineMaterial for thick cube edges (WebGL doesn't
 * support linewidth > 1 on LineBasicMaterial natively).
 *
 * Install: npm install three
 */

import * as THREE from "three";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";

// ── ⚙️ Config — edit these ──────────────────────────────────────────────────

const BALL_COUNT = 55;
const R = 0.1;
const BOUNCE = 0.72; // higher = bouncier, balls stay in 3D longer
const LIN_DAMP = 0.9995; // near 1.0 = barely any drag, balls keep energy across rotations
const GRAV = 9.8;
const SUBSTEPS = 8;

// Cube line thickness in pixels (try 1.5 – 4)
const LINE_WIDTH = 2.5;

// Cube half-size in world units — bigger = larger cube (try 1.0 – 2.5)
const CUBE_SIZE = 1.85;

// Rotation speed — radians per ms (higher = faster spin)
const ROT_X = 0.00048;
const ROT_Y = 0.00082;
const ROT_Z = 0.00022;

// ── Derived ──────────────────────────────────────────────────────────────────
const LIM = CUBE_SIZE - R;
const D = R * 2;
const D2 = D * D;

// Camera sits far enough back that the full diagonal of the cube
// (worst case rotation = sqrt(3)*CUBE_SIZE) fits with padding
// at ANY canvas aspect ratio. Formula: dist = diagonal / tan(FOV/2) * 0.5 * padding
const FOV = 45;
const DIAGONAL = Math.sqrt(3) * CUBE_SIZE;
const PADDING = 1.4; // 40% breathing room around cube
const CAM_DIST = (DIAGONAL / Math.tan(((FOV / 2) * Math.PI) / 180)) * PADDING;

// Canvas height: enough px to show the cube comfortably — simply cube diagonal * 200px/unit
const CANVAS_HEIGHT = Math.round(DIAGONAL * 200 + 80);

// ── Renderer ──────────────────────────────────────────────────────────────────
const canvas = document.getElementById("cube-canvas");
const wrap = canvas.parentElement;
wrap.style.height = `${CANVAS_HEIGHT}px`;

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: true,
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x000000, 0);

const scene = new THREE.Scene();
const cam = new THREE.PerspectiveCamera(FOV, 1, 0.01, 100);
cam.position.set(0, 0, CAM_DIST);

let viewW = 1,
  viewH = 1;

function resize() {
  viewW = wrap.offsetWidth || CANVAS_HEIGHT;
  viewH = wrap.offsetHeight || CANVAS_HEIGHT;
  renderer.setSize(viewW, viewH, false);
  cam.aspect = viewW / viewH;
  cam.updateProjectionMatrix();
  lineMat.resolution.set(viewW, viewH);
}

// ── Cube group ────────────────────────────────────────────────────────────────
const cubeGroup = new THREE.Group();
scene.add(cubeGroup);

// Build edge positions for LineSegmentsGeometry
// BoxGeometry corners
const c = CUBE_SIZE;
const corners = [
  [-c, -c, -c],
  [c, -c, -c],
  [c, c, -c],
  [-c, c, -c],
  [-c, -c, c],
  [c, -c, c],
  [c, c, c],
  [-c, c, c],
];
const edgePairs = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 4],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
];

const edgePositions = [];
for (const [a, b] of edgePairs) {
  edgePositions.push(...corners[a], ...corners[b]);
}

const lineGeo = new LineSegmentsGeometry();
lineGeo.setPositions(edgePositions);

const lineMat = new LineMaterial({
  color: 0x0f0f0f,
  linewidth: LINE_WIDTH,
  worldUnits: false, // false = pixels, true = world units
});

const cubeLines = new LineSegments2(lineGeo, lineMat);
cubeGroup.add(cubeLines);

// ── Balls ─────────────────────────────────────────────────────────────────────
const ballGeo = new THREE.SphereGeometry(R, 14, 10);
const ballMat = new THREE.MeshBasicMaterial({ color: 0x0f0f0f });

const pos = [];
const vel = [];
const meshes = [];

for (let i = 0; i < BALL_COUNT; i++) {
  const p = new THREE.Vector3(
    (Math.random() - 0.5) * CUBE_SIZE * 1.6,
    (Math.random() - 0.5) * CUBE_SIZE * 1.6,
    (Math.random() - 0.5) * CUBE_SIZE * 1.6,
  );
  p.clampScalar(-LIM, LIM);
  pos.push(p);

  vel.push(
    new THREE.Vector3(
      (Math.random() - 0.5) * CUBE_SIZE * 1.5,
      (Math.random() - 0.5) * CUBE_SIZE * 1.5,
      (Math.random() - 0.5) * CUBE_SIZE * 1.5,
    ),
  );

  const m = new THREE.Mesh(ballGeo, ballMat);
  m.position.copy(p);
  cubeGroup.add(m);
  meshes.push(m);
}

// ── Physics ───────────────────────────────────────────────────────────────────
const localGrav = new THREE.Vector3();
const worldDown = new THREE.Vector3(0, -GRAV, 0);
const invQ = new THREE.Quaternion();

function physStep(dt) {
  const sdt = dt / SUBSTEPS;
  const drag = Math.pow(LIN_DAMP, dt);

  for (let s = 0; s < SUBSTEPS; s++) {
    for (let i = 0; i < BALL_COUNT; i++) {
      vel[i].x += localGrav.x * sdt;
      vel[i].y += localGrav.y * sdt;
      vel[i].z += localGrav.z * sdt;
      pos[i].x += vel[i].x * sdt;
      pos[i].y += vel[i].y * sdt;
      pos[i].z += vel[i].z * sdt;
    }

    for (let i = 0; i < BALL_COUNT; i++) {
      const p = pos[i],
        v = vel[i];
      if (p.x < -LIM) {
        p.x = -LIM;
        if (v.x < 0) v.x = -v.x * BOUNCE;
      }
      if (p.x > LIM) {
        p.x = LIM;
        if (v.x > 0) v.x = -v.x * BOUNCE;
      }
      if (p.y < -LIM) {
        p.y = -LIM;
        if (v.y < 0) v.y = -v.y * BOUNCE;
      }
      if (p.y > LIM) {
        p.y = LIM;
        if (v.y > 0) v.y = -v.y * BOUNCE;
      }
      if (p.z < -LIM) {
        p.z = -LIM;
        if (v.z < 0) v.z = -v.z * BOUNCE;
      }
      if (p.z > LIM) {
        p.z = LIM;
        if (v.z > 0) v.z = -v.z * BOUNCE;
      }
    }

    for (let i = 0; i < BALL_COUNT - 1; i++) {
      for (let j = i + 1; j < BALL_COUNT; j++) {
        const dx = pos[j].x - pos[i].x;
        const dy = pos[j].y - pos[i].y;
        const dz = pos[j].z - pos[i].z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= D2 || d2 < 1e-10) continue;
        const d = Math.sqrt(d2);
        const nx = dx / d,
          ny = dy / d,
          nz = dz / d;
        const sep = (D - d) * 0.5;
        pos[i].x -= nx * sep;
        pos[i].y -= ny * sep;
        pos[i].z -= nz * sep;
        pos[j].x += nx * sep;
        pos[j].y += ny * sep;
        pos[j].z += nz * sep;
        const rv =
          (vel[j].x - vel[i].x) * nx +
          (vel[j].y - vel[i].y) * ny +
          (vel[j].z - vel[i].z) * nz;
        if (rv >= 0) continue;
        const imp = rv * (1 + BOUNCE) * 0.5;
        vel[i].x += imp * nx;
        vel[i].y += imp * ny;
        vel[i].z += imp * nz;
        vel[j].x -= imp * nx;
        vel[j].y -= imp * ny;
        vel[j].z -= imp * nz;
      }
    }
  }

  for (let i = 0; i < BALL_COUNT; i++) vel[i].multiplyScalar(drag);
}

// ── Loop ──────────────────────────────────────────────────────────────────────
resize();
window.addEventListener("resize", resize);

let aX = 0.3,
  aY = 0.2,
  aZ = 0.0,
  last = 0;

// Slowly drifting rotation speeds break the periodic gravity cycle
let driftX = ROT_X,
  driftY = ROT_Y,
  driftZ = ROT_Z;
let nextKick = 3.0; // seconds until next random impulse burst

// ── Drag to rotate ─────────────────────────────────────────────────────────
let isDragging = false;
let prevX = 0,
  prevY = 0;
let momentumYaw = 0,
  momentumPitch = 0;
// Raw target that mouse moves instantly — aX/aY lerp toward it
let targetX = 0.3,
  targetY = 0.2;

const DRAG_SENS = 0.005; // mouse sensitivity
const DRAG_LERP = 0.1; // 0.0 = no follow, 1.0 = instant (try 0.08–0.15)
const MOMENTUM_DECAY = 0.88; // spin decay per frame after release

function getXY(e) {
  return e.touches
    ? [e.touches[0].clientX, e.touches[0].clientY]
    : [e.clientX, e.clientY];
}

canvas.addEventListener("mousedown", (e) => {
  isDragging = true;
  [prevX, prevY] = getXY(e);
  momentumYaw = momentumPitch = 0;
  targetX = aX;
  targetY = aY;
  canvas.style.cursor = "grabbing";
});
canvas.addEventListener(
  "touchstart",
  (e) => {
    isDragging = true;
    [prevX, prevY] = getXY(e);
    momentumYaw = momentumPitch = 0;
    targetX = aX;
    targetY = aY;
  },
  { passive: true },
);

window.addEventListener("mousemove", (e) => {
  if (!isDragging) return;
  const [cx, cy] = getXY(e);
  const dx = (cx - prevX) * DRAG_SENS;
  const dy = (cy - prevY) * DRAG_SENS;
  targetY += dx;
  targetX += dy;
  // Track momentum as the raw delta for release throw
  momentumYaw = dx;
  momentumPitch = dy;
  prevX = cx;
  prevY = cy;
});
window.addEventListener(
  "touchmove",
  (e) => {
    if (!isDragging) return;
    const [cx, cy] = getXY(e);
    const dx = (cx - prevX) * DRAG_SENS;
    const dy = (cy - prevY) * DRAG_SENS;
    targetY += dx;
    targetX += dy;
    momentumYaw = dx;
    momentumPitch = dy;
    prevX = cx;
    prevY = cy;
  },
  { passive: true },
);

window.addEventListener("mouseup", () => {
  isDragging = false;
  canvas.style.cursor = "grab";
});
window.addEventListener("touchend", () => {
  isDragging = false;
});

canvas.style.cursor = "grab";

function tick(ts) {
  const dt = Math.min((ts - last) / 1000, 0.033);
  last = ts;

  if (isDragging) {
    // Lerp current rotation toward where the mouse dragged — gives silky lag
    aX += (targetX - aX) * DRAG_LERP;
    aY += (targetY - aY) * DRAG_LERP;
  } else {
    // Apply leftover momentum from drag, decaying each frame
    aY += momentumYaw;
    aX += momentumPitch;
    momentumYaw *= MOMENTUM_DECAY;
    momentumPitch *= MOMENTUM_DECAY;

    // Auto-rotation kicks back in as momentum fades
    const momentumMag = Math.abs(momentumYaw) + Math.abs(momentumPitch);
    const autoBlend = Math.max(0, 1 - momentumMag / 0.01); // blend in auto-spin gradually

    driftX += (Math.random() - 0.5) * 0.000003;
    driftY += (Math.random() - 0.5) * 0.000003;
    driftZ += (Math.random() - 0.5) * 0.000003;
    driftX = Math.max(ROT_X * 0.6, Math.min(ROT_X * 1.4, driftX));
    driftY = Math.max(ROT_Y * 0.6, Math.min(ROT_Y * 1.4, driftY));
    driftZ = Math.max(ROT_Z * 0.6, Math.min(ROT_Z * 1.4, driftZ));

    aX += driftX * dt * 1000 * autoBlend;
    aY += driftY * dt * 1000 * autoBlend;
    aZ += driftZ * dt * 1000 * autoBlend;
  }

  cubeGroup.rotation.set(aX, aY, aZ);

  invQ.setFromEuler(cubeGroup.rotation).invert();
  localGrav.copy(worldDown).applyQuaternion(invQ);

  // Periodic random kicks — re-randomises ball positions every few seconds
  nextKick -= dt;
  if (nextKick <= 0) {
    const kickStr = CUBE_SIZE * 1.5;
    for (let i = 0; i < BALL_COUNT; i++) {
      vel[i].x += (Math.random() - 0.5) * kickStr;
      vel[i].y += (Math.random() - 0.5) * kickStr;
      vel[i].z += (Math.random() - 0.5) * kickStr;
    }
    nextKick = 2.5 + Math.random() * 2.0;
  }

  physStep(dt);

  for (let i = 0; i < BALL_COUNT; i++) meshes[i].position.copy(pos[i]);

  renderer.render(scene, cam);
  requestAnimationFrame(tick);
}

requestAnimationFrame((ts) => {
  last = ts;
  requestAnimationFrame(tick);
});
