import { divider, style } from "./theme.mjs";

function normalizeNewlines(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function parseCodeSpan(text, start) {
  if (text[start] !== "`") {
    return null;
  }

  const markerMatch = /^`+/.exec(text.slice(start));
  const marker = markerMatch?.[0];

  if (!marker) {
    return null;
  }

  const end = text.indexOf(marker, start + marker.length);
  if (end === -1) {
    return null;
  }

  let value = text.slice(start + marker.length, end);

  if (value.startsWith(" ") && value.endsWith(" ") && value.trim()) {
    value = value.slice(1, -1);
  }

  return {
    value,
    next: end + marker.length,
  };
}

function parseLink(text, start) {
  if (text[start] !== "[") {
    return null;
  }

  const labelEnd = text.indexOf("](", start + 1);
  if (labelEnd === -1) {
    return null;
  }

  const urlEnd = text.indexOf(")", labelEnd + 2);
  if (urlEnd === -1) {
    return null;
  }

  const label = text.slice(start + 1, labelEnd);
  const url = text.slice(labelEnd + 2, urlEnd);

  if (!label || !url) {
    return null;
  }

  return {
    label,
    url,
    next: urlEnd + 1,
  };
}

function parseDelimited(text, start, marker) {
  if (!text.startsWith(marker, start)) {
    return null;
  }

  const end = text.indexOf(marker, start + marker.length);
  if (end === -1) {
    return null;
  }

  const value = text.slice(start + marker.length, end);
  if (!value.trim()) {
    return null;
  }

  return {
    value,
    next: end + marker.length,
  };
}

function renderInline(text) {
  let rendered = "";
  let cursor = 0;

  while (cursor < text.length) {
    const codeSpan = parseCodeSpan(text, cursor);
    if (codeSpan) {
      rendered += style(codeSpan.value, "cyan");
      cursor = codeSpan.next;
      continue;
    }

    const link = parseLink(text, cursor);
    if (link) {
      rendered += `${renderInline(link.label)} ${style(`(${link.url})`, "cyan")}`;
      cursor = link.next;
      continue;
    }

    const strong = parseDelimited(text, cursor, "**")
      ?? parseDelimited(text, cursor, "__");
    if (strong) {
      rendered += style(renderInline(strong.value), "bold");
      cursor = strong.next;
      continue;
    }

    const strike = parseDelimited(text, cursor, "~~");
    if (strike) {
      rendered += style(renderInline(strike.value), "dim");
      cursor = strike.next;
      continue;
    }

    rendered += text[cursor];
    cursor += 1;
  }

  return rendered;
}

function parseFence(line) {
  const match = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
  if (!match) {
    return null;
  }

  return {
    marker: match[2],
    info: match[3].trim(),
  };
}

function renderMarkdownLine(line, state) {
  const fence = parseFence(line);

  if (state.inCodeBlock) {
    if (
      fence
      && fence.marker[0] === state.codeFence[0]
      && fence.marker.length >= state.codeFence.length
      && !fence.info
    ) {
      state.inCodeBlock = false;
      state.codeFence = null;
      return "";
    }

    return line ? style(`    ${line}`, "cyan") : "";
  }

  if (fence) {
    state.inCodeBlock = true;
    state.codeFence = fence.marker;
    return style(
      fence.info ? `[code: ${fence.info}]` : "[code]",
      "gray",
    );
  }

  if (/^\s{0,3}(?:[-*_]\s*){3,}$/.test(line)) {
    return style(divider(), "gray");
  }

  const headingMatch = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
  if (headingMatch) {
    const level = headingMatch[1].length;
    const color = level <= 2 ? "yellow" : "cyan";
    return style(renderInline(headingMatch[2].trim()), "bold", color);
  }

  const blockquoteMatch = line.match(/^\s{0,3}((>\s?)+)(.*)$/);
  if (blockquoteMatch) {
    const depth = (blockquoteMatch[1].match(/>/g) ?? []).length;
    return `${"  ".repeat(Math.max(0, depth - 1))}${style(">", "gray")} ${renderInline(blockquoteMatch[3])}`;
  }

  const unorderedMatch = line.match(
    /^(\s*)([-+*])\s+(\[(?: |x|X)\]\s+)?(.*)$/,
  );
  if (unorderedMatch) {
    const checkbox = unorderedMatch[3] ?? "";
    return `${unorderedMatch[1]}- ${checkbox}${renderInline(unorderedMatch[4])}`;
  }

  const orderedMatch = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
  if (orderedMatch) {
    return `${orderedMatch[1]}${orderedMatch[2]}. ${renderInline(orderedMatch[3])}`;
  }

  return renderInline(line);
}

export function createMarkdownStreamRenderer({ write }) {
  const state = {
    buffer: "",
    inCodeBlock: false,
    codeFence: null,
  };

  const flushLine = (line, appendNewline) => {
    write(renderMarkdownLine(line, state));
    if (appendNewline) {
      write("\n");
    }
  };

  return {
    push(text) {
      if (!text) {
        return;
      }

      state.buffer += text;
      state.buffer = normalizeNewlines(state.buffer);

      let newlineIndex = state.buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = state.buffer.slice(0, newlineIndex);
        state.buffer = state.buffer.slice(newlineIndex + 1);
        flushLine(line, true);
        newlineIndex = state.buffer.indexOf("\n");
      }
    },

    finish() {
      if (!state.buffer) {
        return;
      }

      flushLine(state.buffer, false);
      state.buffer = "";
    },
  };
}

export function renderMarkdown(text) {
  const output = [];
  const renderer = createMarkdownStreamRenderer({
    write: (chunk) => {
      output.push(chunk);
    },
  });

  renderer.push(text);
  renderer.finish();

  return output.join("");
}
