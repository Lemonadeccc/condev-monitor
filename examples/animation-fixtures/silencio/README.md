# Silencio Next App

This folder is a standalone Next.js reconstruction of the downloaded
`silencio.es` page. Its 57-file `public/` tree was restored byte-for-byte from
the local source snapshot at `/Users/lemonade/Downloads/github/silencio/silencio.es/app/public`.
It includes the product GLBs, HDR environment, Draco decoder, images, fonts,
audio, manifest, and icons used by the page.

## Development

```bash
pnpm dev
```

Open `http://127.0.0.1:43105`.

Animation monitoring starts locally without a DSN. To test an approved upload
target, provide `NEXT_PUBLIC_MONITOR_DSN` only in the command environment; do
not add it to an `.env` file.

The integration uses one shared React animation client, a public root Profiler,
one local component scope bound to the existing `#wrapper`, and a public
Three/WebGL renderer adapter around the original render call. No React Fiber or
Three private fields are inspected. The reviewed Lab scenario now loads the
restored scene and records non-zero draw-call and triangle evidence; it still
does not claim that every possible product state or animation was triggered.

## Production

```bash
pnpm build
pnpm start
```

The restored page is served from `/`.
