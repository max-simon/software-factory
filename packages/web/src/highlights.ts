// Text highlights through the CSS Custom Highlight API: ranges are painted
// without touching the DOM, so React keeps owning the rendered markdown.

const isSupported = typeof CSS !== 'undefined' && 'highlights' in CSS;

export function setHighlight(name: string, ranges: Range[]): void {
  if (!isSupported) return;
  if (ranges.length === 0) CSS.highlights.delete(name);
  else CSS.highlights.set(name, new Highlight(...ranges));
}

/** Collapses whitespace the way a selection's text does across lines and blocks. */
export const normalizeQuote = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** First range under `root` whose text matches `quote`, ignoring whitespace differences. */
export function findTextRange(root: Node, quote: string): Range | undefined {
  const target = normalizeQuote(quote);
  if (!target) return undefined;
  let text = '';
  const positions: Array<[Text, number]> = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    for (let i = 0; i < node.data.length; i++) {
      const char = /\s/.test(node.data[i]!) ? ' ' : node.data[i]!;
      if (char === ' ' && (text === '' || text.endsWith(' '))) continue;
      text += char;
      positions.push([node, i]);
    }
  }
  const start = text.indexOf(target);
  if (start < 0) return undefined;
  const [startNode, startOffset] = positions[start]!;
  const [endNode, endOffset] = positions[start + target.length - 1]!;
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset + 1);
  return range;
}
