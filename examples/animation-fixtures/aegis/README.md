# AEGIS animation fixture

This folder contains the readable AEGIS reconstruction used as a Condev
animation-monitoring fixture.

The application uses:

- React Three Fiber `9.6.1`
- Drei `ScrollControls`, `useScroll`, and `useGLTF`
- Three.js `0.184.0` with a WebGPU-first node renderer
- TSL `MeshStandardNodeMaterial`
- TSL render pipeline with bloom, chromatic aberration, vignette, and grain
- GSAP `3.15.0`, `@gsap/react`, ScrambleText, and SplitText
- A hidden `lil-gui` tuning panel

## Run

```bash
pnpm --filter aegis dev
```

Open `http://127.0.0.1:43104`.

Animation monitoring is initialized once from `instrumentation-client.js`.
`components/AegisCanvas.jsx` adds only the public React Profiler and R3F
observer around the existing scene. Local development needs no DSN and does
not upload. To test an approved upload target, provide
`NEXT_PUBLIC_MONITOR_DSN` only in the command environment; do not add it to an
`.env` file.

## Controls

- Scroll or swipe to move through the five scene stages.
- Select a marker on the right rail to jump to a stage.
- Press `G` to show or hide the runtime tuning panel.
- Press `Escape` to close the contact overlay.

## Renderer behavior

The recovered bundle hard-failed when WebGPU was unavailable. This rebuild
prefers WebGPU but intentionally falls back to Three's WebGL 2 node backend so
the isolated comparison remains testable on more browsers. Both paths use the
same TSL node materials and render pipeline.

The camera constants, scroll damping, antenna reveal parameters, post-effect
defaults, model asset, copy, and HUD geometry were recovered from the bundle.
Source filenames and the original package manifest could not be recovered
because no source map was present.

See [`BUNDLE_ANALYSIS.md`](./BUNDLE_ANALYSIS.md) for the dependency evidence,
model structure, material graph, camera equations, and WebGPU effect breakdown.
