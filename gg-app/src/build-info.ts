export interface AppBuildInfo {
  localPatched: boolean;
  sourceRoot: string;
  customLabel: string;
  gitSha: string;
}

export const appBuildInfo: AppBuildInfo = {
  localPatched: import.meta.env.VITE_GG_LOCAL_PATCHED === "1",
  sourceRoot: import.meta.env.VITE_GG_SOURCE_ROOT ?? "",
  customLabel: import.meta.env.VITE_GG_CUSTOM_BUILD_LABEL ?? "",
  gitSha: import.meta.env.VITE_GG_GIT_SHA ?? "",
};

export function formatBuildIdentity(): string {
  return [appBuildInfo.customLabel, appBuildInfo.gitSha].filter(Boolean).join(" · ");
}

export function formatVersionLabel(version: string): string {
  const identity = formatBuildIdentity();
  return identity ? `v${version} · ${identity}` : `v${version}`;
}
