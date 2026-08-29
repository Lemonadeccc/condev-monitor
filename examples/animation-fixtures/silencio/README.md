# Silencio Next App

This folder is a standalone Next.js reconstruction of the downloaded
`silencio.es` page.

The current snapshot does not contain its original `public/` asset directory.
The Next.js application and Condev animation monitor build and start, but the
page currently returns `404` for its referenced images, fonts, audio, HDR, and
GLB files. The bundled Lab scenario therefore exercises only the available
page, WebGL canvas, pointer, scroll, and resize surfaces; it does not claim that
the asset-dependent entry flow or product animations completed.

## Development

```bash
pnpm dev
```

Open `http://127.0.0.1:43105`.

Animation monitoring starts locally without a DSN. To test an approved upload
target, provide `NEXT_PUBLIC_MONITOR_DSN` only in the command environment; do
not add it to an `.env` file.

The integration uses one shared React animation client, a public root Profiler,
one local component scope bound to the existing `#wrapper`, and a fail-open
Three/WebGL renderer adapter around the original render call. No React Fiber or
Three private fields are inspected. Because the missing GLB/HDR assets prevent
the original scene from completing, renderer instrumentation working here is
not evidence that every product animation completed.

## Production

```bash
pnpm build
pnpm start
```

The restored page is served from `/`.
