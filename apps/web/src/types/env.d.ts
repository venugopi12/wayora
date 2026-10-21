/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Public base URL of the Wayora API. Safe to expose — never put secrets in VITE_* vars. */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
