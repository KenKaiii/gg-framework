/** Folder name of GG Motion's video workspace inside the projects root. */
export const MOTION_FOLDER_NAME = "GG Motion";
/** Folder name of GG Chat's workspace inside the projects root. */
export const CHAT_FOLDER_NAME = "GG Chat";

/** `name` inside the projects root, joined with the root's own separator. */
function workspaceFolderPath(projectsRoot: string, name: string): string {
  const sep = projectsRoot.includes("\\") && !projectsRoot.includes("/") ? "\\" : "/";
  const root = projectsRoot.replace(/[\\/]+$/, "");
  return `${root}${sep}${name}`;
}

/** GG Motion's workspace path inside the projects root. */
export function motionWorkspacePath(projectsRoot: string): string {
  return workspaceFolderPath(projectsRoot, MOTION_FOLDER_NAME);
}

/** GG Chat's workspace path inside the projects root. */
export function chatWorkspacePath(projectsRoot: string): string {
  return workspaceFolderPath(projectsRoot, CHAT_FOLDER_NAME);
}
