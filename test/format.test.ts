import { describe, expect, test } from "bun:test";
import { htmlEscape, formatForTelegram } from "../lib/format.ts";

describe("htmlEscape", () => {
  test("escapes &, <, >", () => {
    expect(htmlEscape("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });
  test("leaves safe characters alone", () => {
    expect(htmlEscape("hello world")).toBe("hello world");
  });
  test("escapes & before < to avoid double-encoding", () => {
    expect(htmlEscape("<&>")).toBe("&lt;&amp;&gt;");
  });
});

describe("formatForTelegram - inline markdown", () => {
  test("**bold** becomes <b>bold</b>", () => {
    expect(formatForTelegram("**SUMMARY** line")).toBe("<b>SUMMARY</b> line");
  });

  test("__alt-bold__ becomes <b>alt-bold</b>", () => {
    expect(formatForTelegram("__alt__ word")).toBe("<b>alt</b> word");
  });

  test("*italic* becomes <i>italic</i>", () => {
    expect(formatForTelegram("an *italic* word")).toBe("an <i>italic</i> word");
  });

  test("_italic_ becomes <i>italic</i>", () => {
    expect(formatForTelegram("an _italic_ word")).toBe("an <i>italic</i> word");
  });

  test("snake_case_words are NOT italicised", () => {
    expect(formatForTelegram("call my_function here")).toBe("call my_function here");
  });

  test("multiplication asterisks are NOT italicised", () => {
    expect(formatForTelegram("2*3*5 equals thirty")).toBe("2*3*5 equals thirty");
  });

  test("bold and italic combine", () => {
    expect(formatForTelegram("*italic* and **bold** together")).toBe(
      "<i>italic</i> and <b>bold</b> together"
    );
  });
});

describe("formatForTelegram - code", () => {
  test("inline `code` becomes <code>code</code>", () => {
    expect(formatForTelegram("an inline `code` block")).toBe(
      "an inline <code>code</code> block"
    );
  });

  test("code body preserves <, >, & via escaping", () => {
    expect(formatForTelegram("the `<script>` tag")).toBe(
      "the <code>&lt;script&gt;</code> tag"
    );
  });

  test("markdown inside code is preserved literally", () => {
    expect(formatForTelegram("`**not bold**`")).toBe("<code>**not bold**</code>");
  });

  test("fenced ```code``` becomes <pre>", () => {
    expect(formatForTelegram("```\nhello\n```")).toBe("<pre>hello</pre>");
  });

  test("fenced ```lang code``` becomes <pre><code class=language-lang>", () => {
    expect(formatForTelegram("```ts\nconst x = 1\n```")).toBe(
      '<pre><code class="language-ts">const x = 1</code></pre>'
    );
  });
});

describe("formatForTelegram - block-level", () => {
  test("# Heading becomes bold line", () => {
    expect(formatForTelegram("# Big Title")).toBe("<b>Big Title</b>");
  });

  test("### Subheading also becomes bold", () => {
    expect(formatForTelegram("### Small Title")).toBe("<b>Small Title</b>");
  });

  test("- bullet becomes • bullet", () => {
    expect(formatForTelegram("- first\n- second")).toBe("• first\n• second");
  });

  test("* bullet also becomes •", () => {
    expect(formatForTelegram("* first")).toBe("• first");
  });
});

describe("formatForTelegram - links", () => {
  test("[text](url) becomes anchor tag", () => {
    expect(formatForTelegram("see [docs](https://example.com) here")).toBe(
      'see <a href="https://example.com">docs</a> here'
    );
  });
});

describe("formatForTelegram - escaping outside code", () => {
  test("raw <, >, & get HTML-escaped", () => {
    expect(formatForTelegram("hello <world> & friends")).toBe(
      "hello &lt;world&gt; &amp; friends"
    );
  });

  test("HTML escape happens BEFORE markdown transform so <b> in input is literal", () => {
    expect(formatForTelegram("not real <b>tags</b>")).toBe(
      "not real &lt;b&gt;tags&lt;/b&gt;"
    );
  });
});

describe("formatForTelegram - resilience", () => {
  test("empty string returns empty string", () => {
    expect(formatForTelegram("")).toBe("");
  });

  test("plain text passes through unchanged", () => {
    expect(formatForTelegram("just a sentence.")).toBe("just a sentence.");
  });

  test("multi-paragraph input preserves newlines", () => {
    expect(formatForTelegram("para one\n\npara two")).toBe("para one\n\npara two");
  });

  test("nested-but-not-balanced markers degrade gracefully", () => {
    // *one **two** three* - the outer italic and inner bold both close cleanly
    const out = formatForTelegram("*one **two** three*");
    expect(out).toContain("<i>");
    expect(out).toContain("<b>two</b>");
  });
});
