import { memo } from 'react';
import { Markdown } from './Markdown.tsx';

const isMarkdown = (kind: string): boolean => /^(md|markdown|text\/markdown)$/i.test(kind);

// Memoized so polling re-renders keep the same DOM text nodes, which review highlights point into.
export const ArtifactContent = memo(function ArtifactContent({ kind, content }: { kind: string; content: string }) {
  return isMarkdown(kind) ? <Markdown>{content}</Markdown> : <pre>{content}</pre>;
});
