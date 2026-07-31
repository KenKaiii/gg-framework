import { WorkspaceShell } from "./WorkspaceShell";
import "./App.css";

export type { Item } from "./AgentPane";

export default function App(): React.ReactElement {
  return <WorkspaceShell />;
}
