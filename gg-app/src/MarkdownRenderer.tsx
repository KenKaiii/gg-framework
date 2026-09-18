import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { rehypeAnimateWords } from "./rehype-animate-words";
import "highlight.js/styles/github-dark.css";

const ANIMATED_PLUGINS = [rehypeHighlight, rehypeAnimateWords];
const PLUGINS = [rehypeHighlight];

/** Loaded only when a message needs rich text, not during workspace startup. */
export function MarkdownRenderer({
  children,
  animate,
  components,
}: {
  children: string;
  animate: boolean;
  components: Components;
}): React.ReactElement {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={animate ? ANIMATED_PLUGINS : PLUGINS}
      components={components}
    >
      {children}
    </ReactMarkdown>
  );
}
