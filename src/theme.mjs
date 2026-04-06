const COLORS_ENABLED = Boolean(process.stdout.isTTY && !process.env.NO_COLOR);

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

export function style(text, ...names) {
  if (!COLORS_ENABLED || names.length === 0) {
    return text;
  }

  const prefix = names
    .map((name) => ANSI[name] ?? "")
    .join("");

  return `${prefix}${text}${ANSI.reset}`;
}

export function divider(width = process.stdout.columns ?? 72, char = "-") {
  const safeWidth = Number.isFinite(width) ? width : 72;
  return char.repeat(Math.max(16, Math.min(safeWidth, 72)));
}

export function heading(title, color = "cyan") {
  return `${style(title.toUpperCase(), "bold", color)}\n${style(divider(), "gray")}`;
}

export function label(name, value) {
  return `${style(`${name}:`, "bold")} ${value}`;
}

export function badge(text, color = "green") {
  return style(`[${text}]`, "bold", color);
}

export function truncateMiddle(text, max = 72) {
  if (text.length <= max) {
    return text;
  }

  const left = Math.floor((max - 3) / 2);
  const right = max - left - 3;
  return `${text.slice(0, left)}...${text.slice(text.length - right)}`;
}

export function previewText(text, max = 72) {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (!singleLine) {
    return "(empty)";
  }
  return truncateMiddle(singleLine, max);
}
