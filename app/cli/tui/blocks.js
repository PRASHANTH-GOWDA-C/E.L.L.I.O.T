/**
 * Splits a (possibly still streaming) reply into text and fenced code blocks.
 * An unclosed fence counts as a code block that runs to the end.
 * @returns {({ type: 'text', text: string } | { type: 'code', lang: string, code: string })[]}
 */
export function parseBlocks(text) {
  const blocks = [];
  let textLines = [];
  let code = null; // { lang, lines } while inside a fence

  const flushText = () => {
    const joined = textLines.join('\n').replace(/^\n+|\n+$/g, '');
    if (joined) blocks.push({ type: 'text', text: joined });
    textLines = [];
  };

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (code) {
      if (trimmed.startsWith('```')) {
        blocks.push({ type: 'code', lang: code.lang, code: code.lines.join('\n') });
        code = null;
      } else {
        code.lines.push(line);
      }
    } else if (trimmed.startsWith('```')) {
      flushText();
      code = { lang: trimmed.slice(3).trim(), lines: [] };
    } else {
      textLines.push(line);
    }
  }

  if (code) {
    // Still streaming: hide the empty line that starts after the latest "\n".
    if (code.lines.at(-1) === '') code.lines.pop();
    blocks.push({ type: 'code', lang: code.lang, code: code.lines.join('\n') });
  } else {
    flushText();
  }
  return blocks;
}
