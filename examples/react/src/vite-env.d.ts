/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_CONDEV_DSN: string
}

interface ImportMeta {
    readonly env: ImportMetaEnv
}
