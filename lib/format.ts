// Pure helpers for converting Claude's CommonMark-flavoured output into
// Telegram HTML. No I/O, no imports beyond core; safe to unit-test.
//
// Telegram HTML parse_mode supports a fixed tag set: <b>, <strong>, <i>,
// <em>, <u>, <ins>, <s>, <strike>, <del>, <tg-spoiler>, <a href>, <code>,
// <pre>, and <pre><code class="language-X">. There is no list element; we
// render Markdown bullets as a literal '•' character.
//
// Outside <code>/<pre> regions we escape only '<', '>', '&' so the rest of
// the markdown transforms can run cleanly. Inside <code>/<pre> we escape
// those same three but DO NOT touch markdown markers, so backticks survive.

export function htmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatForTelegram(text: string): string {
  // Pass 1: extract code regions and replace each with an opaque sentinel.
  // The slot is a NUL-delimited token that can't appear in Markdown input
  // and survives the html-escape and regex passes that follow.
  const codeSlots: string[] = [];
  const slot = (s: string): string => {
    const key = `\x00CODE${codeSlots.length}\x00`;
    codeSlots.push(s);
    return key;
  };

  // Fenced code blocks ```lang\n...\n```
  text = text.replace(/```([a-zA-Z0-9_+-]*)?\n?([\s\S]*?)```/g, (_m, lang, body) => {
    const esc = htmlEscape(String(body).replace(/\n$/, ""));
    if (lang) {
      return slot(`<pre><code class="language-${htmlEscape(String(lang))}">${esc}</code></pre>`);
    }
    return slot(`<pre>${esc}</pre>`);
  });

  // Inline code `...`
  text = text.replace(/`([^`\n]+)`/g, (_m, body) => slot(`<code>${htmlEscape(String(body))}</code>`));

  // Now safe to html-escape the remaining text (no markdown transforms have
  // emitted real angle brackets yet)
  text = htmlEscape(text);

  // Bold: **X** or __X__ -> <b>X</b>
  text = text.replace(/\*\*([^*\n]+?)\*\*/g, "<b>$1</b>");
  text = text.replace(/__([^_\n]+?)__/g, "<b>$1</b>");

  // Italic: *X* or _X_ when adjacent to whitespace/punctuation. The
  // boundary check avoids snake_case_words and arithmetic getting italicised.
  text = text.replace(/(^|[\s(])\*([^*\n]+?)\*(?=$|[\s.,;:!?)])/g, "$1<i>$2</i>");
  text = text.replace(/(^|[\s(])_([^_\n]+?)_(?=$|[\s.,;:!?)])/g, "$1<i>$2</i>");

  // Headings (# .. ######) -> bold line, drop the hashes
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // Bulleted lists: lines starting with "- " or "* " -> "• "
  text = text.replace(/^[\s]*[-*]\s+/gm, "• ");

  // Markdown links [text](url) -> <a href="url">text</a>. text is already
  // html-escaped at this point; the [] markers are literal characters.
  text = text.replace(/\[([^\]\n]+)\]\(([^)\n\s]+)\)/g, (_m, label, url) => {
    return `<a href="${url}">${label}</a>`;
  });

  // Pass 2: restore code slots
  text = text.replace(/\x00CODE(\d+)\x00/g, (_m, i) => codeSlots[Number(i)] ?? "");
  return text;
}
