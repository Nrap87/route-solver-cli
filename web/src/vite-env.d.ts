/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_PROXY_TARGET?: string;
  readonly VITE_PLAYER_GUID?: string;
  readonly VITE_PLAYER_EMAIL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
