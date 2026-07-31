/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GG_LOCAL_PATCHED?: string;
  readonly VITE_GG_SOURCE_ROOT?: string;
  readonly VITE_GG_CUSTOM_BUILD_LABEL?: string;
  readonly VITE_GG_GIT_SHA?: string;
}
