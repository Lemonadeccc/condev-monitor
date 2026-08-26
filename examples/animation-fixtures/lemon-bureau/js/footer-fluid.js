// Minimal 2D incompressible velocity field (forces → projection) for footer particles.
// Tuned to mirror the "feel" of fluid-master's force + 50-iter pressure projection.

export class FooterFluidField {
  constructor({
    widthPx,
    heightPx,
    cellSizePx = 14,
    pressureIterations = 50,
    velocityDamping = 0.99,
  }) {
    this.cellSizePx = cellSizePx;
    this.pressureIterations = pressureIterations;
    this.velocityDamping = velocityDamping;

    this.resize(widthPx, heightPx);
  }

  resize(widthPx, heightPx) {
    this.widthPx = Math.max(1, widthPx | 0);
    this.heightPx = Math.max(1, heightPx | 0);

    this.nx = Math.max(8, Math.floor(this.widthPx / this.cellSizePx));
    this.ny = Math.max(8, Math.floor(this.heightPx / this.cellSizePx));

    // Staggering not required for this use; keep a simple cell-centered grid.
    this.size = this.nx * this.ny;

    this.u = new Float32Array(this.size);
    this.v = new Float32Array(this.size);
    this.uPrev = new Float32Array(this.size);
    this.vPrev = new Float32Array(this.size);
    this.p = new Float32Array(this.size);
    this.div = new Float32Array(this.size);
  }

  step(dt, { mouseX, mouseY, mouseDX, mouseDY, mouseRadiusPx, mouseStrength }) {
    const dts = Math.max(0, dt);

    // Copy current velocity to prev buffers (for advection).
    this.uPrev.set(this.u);
    this.vPrev.set(this.v);

    // External forces (mouse "splat")
    if (
      Number.isFinite(mouseX) &&
      Number.isFinite(mouseY) &&
      Number.isFinite(mouseDX) &&
      Number.isFinite(mouseDY) &&
      mouseRadiusPx > 0 &&
      mouseStrength !== 0
    ) {
      this.#addMouseForce(dts, mouseX, mouseY, mouseDX, mouseDY, mouseRadiusPx, mouseStrength);
    }

    // Mild damping like a "dissipation" knob (fluid-master doesn't advect grid velocity,
    // but the footer needs persistence without exploding).
    const damp = Math.min(1, Math.max(0, this.velocityDamping));
    for (let i = 0; i < this.size; i++) {
      this.u[i] *= damp;
      this.v[i] *= damp;
    }

    // Advect velocity by itself (semi-Lagrangian).
    this.#advectVelocity(dts);

    // Enforce solid boundaries (no flow through edges).
    this.#enforceBoundaries();

    // Project to make velocity divergence-free (pressure solve).
    this.#project();
  }

  sample(xPx, yPx) {
    // Bilinear sample in pixel space.
    const x = (xPx / this.widthPx) * (this.nx - 1);
    const y = (yPx / this.heightPx) * (this.ny - 1);

    const x0 = Math.max(0, Math.min(this.nx - 1, Math.floor(x)));
    const y0 = Math.max(0, Math.min(this.ny - 1, Math.floor(y)));
    const x1 = Math.min(this.nx - 1, x0 + 1);
    const y1 = Math.min(this.ny - 1, y0 + 1);

    const sx = x - x0;
    const sy = y - y0;

    const i00 = this.#idx(x0, y0);
    const i10 = this.#idx(x1, y0);
    const i01 = this.#idx(x0, y1);
    const i11 = this.#idx(x1, y1);

    const u0 = this.u[i00] * (1 - sx) + this.u[i10] * sx;
    const u1 = this.u[i01] * (1 - sx) + this.u[i11] * sx;
    const v0 = this.v[i00] * (1 - sx) + this.v[i10] * sx;
    const v1 = this.v[i01] * (1 - sx) + this.v[i11] * sx;

    return {
      u: u0 * (1 - sy) + u1 * sy,
      v: v0 * (1 - sy) + v1 * sy,
    };
  }

  #idx(x, y) {
    return y * this.nx + x;
  }

  #addMouseForce(dt, mouseX, mouseY, mouseDX, mouseDY, radiusPx, strength) {
    const r = radiusPx;
    const r2 = r * r;

    const cx = (mouseX / this.widthPx) * (this.nx - 1);
    const cy = (mouseY / this.heightPx) * (this.ny - 1);
    const cr = (r / Math.max(1, this.widthPx)) * (this.nx - 1);
    const cr2 = cr * cr;

    // fluid-master uses ~3x multiplier and timeStep gating; approximate that feel here.
    const k = strength * 3.0 * (0.15 + Math.min(1, dt * 60) * 0.85);

    const minX = Math.max(0, Math.floor(cx - cr - 1));
    const maxX = Math.min(this.nx - 1, Math.ceil(cx + cr + 1));
    const minY = Math.max(0, Math.floor(cy - cr - 1));
    const maxY = Math.min(this.ny - 1, Math.ceil(cy + cr + 1));

    // Scale mouse delta (px/frame) into grid velocity units (px/sec-ish).
    const fx = (mouseDX / Math.max(1e-6, dt)) * k;
    const fy = (mouseDY / Math.max(1e-6, dt)) * k;

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 > cr2) continue;

        const t = 1 - d2 / Math.max(1e-6, cr2);
        const falloff = t * t * (3 - 2 * t); // smoothstep

        const i = this.#idx(x, y);
        this.u[i] += fx * falloff;
        this.v[i] += fy * falloff;
      }
    }
  }

  #advectVelocity(dt) {
    if (dt <= 0) return;

    const nx = this.nx;
    const ny = this.ny;
    const invW = 1 / Math.max(1, this.widthPx);
    const invH = 1 / Math.max(1, this.heightPx);

    // Backtrace in normalized grid coordinates.
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const i = this.#idx(x, y);
        const u = this.uPrev[i];
        const v = this.vPrev[i];

        // Convert velocity (px/s) into grid-cell displacement.
        const px = (x / Math.max(1, nx - 1)) * this.widthPx;
        const py = (y / Math.max(1, ny - 1)) * this.heightPx;
        const bx = px - u * dt;
        const by = py - v * dt;

        const sx = (bx * invW) * (nx - 1);
        const sy = (by * invH) * (ny - 1);

        const x0 = Math.max(0, Math.min(nx - 1, Math.floor(sx)));
        const y0 = Math.max(0, Math.min(ny - 1, Math.floor(sy)));
        const x1 = Math.min(nx - 1, x0 + 1);
        const y1 = Math.min(ny - 1, y0 + 1);
        const tx = sx - x0;
        const ty = sy - y0;

        const i00 = this.#idx(x0, y0);
        const i10 = this.#idx(x1, y0);
        const i01 = this.#idx(x0, y1);
        const i11 = this.#idx(x1, y1);

        const u0 = this.uPrev[i00] * (1 - tx) + this.uPrev[i10] * tx;
        const u1 = this.uPrev[i01] * (1 - tx) + this.uPrev[i11] * tx;
        const v0 = this.vPrev[i00] * (1 - tx) + this.vPrev[i10] * tx;
        const v1 = this.vPrev[i01] * (1 - tx) + this.vPrev[i11] * tx;

        this.u[i] = u0 * (1 - ty) + u1 * ty;
        this.v[i] = v0 * (1 - ty) + v1 * ty;
      }
    }
  }

  #enforceBoundaries() {
    const nx = this.nx;
    const ny = this.ny;

    // Zero velocity at the edges (simple solid boundary).
    for (let x = 0; x < nx; x++) {
      this.u[this.#idx(x, 0)] = 0;
      this.v[this.#idx(x, 0)] = 0;
      this.u[this.#idx(x, ny - 1)] = 0;
      this.v[this.#idx(x, ny - 1)] = 0;
    }
    for (let y = 0; y < ny; y++) {
      this.u[this.#idx(0, y)] = 0;
      this.v[this.#idx(0, y)] = 0;
      this.u[this.#idx(nx - 1, y)] = 0;
      this.v[this.#idx(nx - 1, y)] = 0;
    }
  }

  #project() {
    const nx = this.nx;
    const ny = this.ny;
    const invDx = (nx - 1) / Math.max(1, this.widthPx);
    const invDy = (ny - 1) / Math.max(1, this.heightPx);

    // Divergence
    for (let y = 1; y < ny - 1; y++) {
      for (let x = 1; x < nx - 1; x++) {
        const i = this.#idx(x, y);
        const du = (this.u[this.#idx(x + 1, y)] - this.u[this.#idx(x - 1, y)]) * 0.5 * invDx;
        const dv = (this.v[this.#idx(x, y + 1)] - this.v[this.#idx(x, y - 1)]) * 0.5 * invDy;
        this.div[i] = du + dv;
        this.p[i] = 0;
      }
    }

    // Pressure solve (Gauss-Seidel), iteration count matches fluid-master default (50).
    const iters = Math.max(1, this.pressureIterations | 0);
    for (let k = 0; k < iters; k++) {
      for (let y = 1; y < ny - 1; y++) {
        for (let x = 1; x < nx - 1; x++) {
          const i = this.#idx(x, y);
          this.p[i] =
            (this.p[this.#idx(x + 1, y)] +
              this.p[this.#idx(x - 1, y)] +
              this.p[this.#idx(x, y + 1)] +
              this.p[this.#idx(x, y - 1)] -
              this.div[i]) *
            0.25;
        }
      }
    }

    // Subtract pressure gradient.
    for (let y = 1; y < ny - 1; y++) {
      for (let x = 1; x < nx - 1; x++) {
        const i = this.#idx(x, y);
        const gradPx = (this.p[this.#idx(x + 1, y)] - this.p[this.#idx(x - 1, y)]) * 0.5 * invDx;
        const gradPy = (this.p[this.#idx(x, y + 1)] - this.p[this.#idx(x, y - 1)]) * 0.5 * invDy;
        this.u[i] -= gradPx;
        this.v[i] -= gradPy;
      }
    }

    this.#enforceBoundaries();
  }
}

