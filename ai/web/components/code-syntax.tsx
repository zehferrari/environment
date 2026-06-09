type SyntaxLanguage =
  | "css"
  | "generic"
  | "javascript"
  | "json"
  | "markdown"
  | "markup"
  | "python"
  | "shell"
  | "sql"
  | "yaml";

type TokenKind =
  | "attr"
  | "comment"
  | "function"
  | "keyword"
  | "literal"
  | "meta"
  | "number"
  | "operator"
  | "property"
  | "punctuation"
  | "string"
  | "tag"
  | "variable";

type Segment = {
  text: string;
  kind?: TokenKind;
};

const TOKEN_CLASS: Record<TokenKind, string> = {
  attr: "text-[#d19a66]",
  comment: "text-[var(--color-text-muted)] italic",
  function: "text-[#61afef]",
  keyword: "text-[#c678dd]",
  literal: "text-[#56b6c2]",
  meta: "text-[#56b6c2]",
  number: "text-[#d19a66]",
  operator: "text-[#56b6c2]",
  property: "text-[#e5c07b]",
  punctuation: "text-[#7f8a99]",
  string: "text-[#98c379]",
  tag: "text-[#e06c75]",
  variable: "text-[#e5c07b]",
};

const JAVASCRIPT_KEYWORDS = new Set([
  "abstract",
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "constructor",
  "continue",
  "debugger",
  "declare",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "get",
  "if",
  "implements",
  "import",
  "in",
  "infer",
  "instanceof",
  "interface",
  "is",
  "keyof",
  "let",
  "namespace",
  "new",
  "null",
  "of",
  "private",
  "protected",
  "public",
  "readonly",
  "return",
  "satisfies",
  "set",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

const PYTHON_KEYWORDS = new Set([
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "False",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "None",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "True",
  "try",
  "while",
  "with",
  "yield",
]);

const SHELL_KEYWORDS = new Set([
  "case",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "export",
  "fi",
  "for",
  "function",
  "if",
  "in",
  "local",
  "readonly",
  "return",
  "set",
  "shift",
  "then",
  "until",
  "while",
]);

const SQL_KEYWORDS = new Set([
  "alter",
  "and",
  "as",
  "asc",
  "begin",
  "by",
  "case",
  "commit",
  "create",
  "delete",
  "desc",
  "distinct",
  "drop",
  "else",
  "end",
  "from",
  "group",
  "having",
  "in",
  "insert",
  "into",
  "is",
  "join",
  "left",
  "like",
  "limit",
  "not",
  "null",
  "on",
  "or",
  "order",
  "outer",
  "primary",
  "references",
  "right",
  "rollback",
  "select",
  "set",
  "table",
  "then",
  "update",
  "values",
  "when",
  "where",
]);

export function SyntaxLine({ line, path }: { line: string; path: string }) {
  const language = languageForPath(path);
  const segments = highlightLine(line, language);
  if (segments.length === 0) return <> </>;
  return (
    <>
      {segments.map((segment, index) => (
        <span key={index} className={segment.kind ? TOKEN_CLASS[segment.kind] : undefined}>
          {segment.text}
        </span>
      ))}
    </>
  );
}

function languageForPath(filePath: string): SyntaxLanguage {
  const parts = filePath.toLowerCase().split("/");
  const filename = parts.at(-1) ?? "";
  const ext = filename.includes(".") ? filename.split(".").at(-1) ?? "" : "";

  if (["dockerfile", "makefile"].includes(filename)) return "shell";
  if (["bashrc", "zshrc"].includes(filename)) return "shell";
  if (["js", "jsx", "mjs", "cjs", "ts", "tsx"].includes(ext)) return "javascript";
  if (["json", "jsonc"].includes(ext)) return "json";
  if (["css", "scss", "sass", "less"].includes(ext)) return "css";
  if (["html", "htm", "xml", "svg"].includes(ext)) return "markup";
  if (["md", "mdx", "markdown"].includes(ext)) return "markdown";
  if (["yml", "yaml"].includes(ext)) return "yaml";
  if (["sh", "bash", "zsh", "fish"].includes(ext)) return "shell";
  if (["py"].includes(ext)) return "python";
  if (["sql"].includes(ext)) return "sql";
  return "generic";
}

function highlightLine(line: string, language: SyntaxLanguage): Segment[] {
  if (!line) return [];
  switch (language) {
    case "css":
      return highlightCss(line);
    case "javascript":
      return highlightCodeLike(line, {
        keywords: JAVASCRIPT_KEYWORDS,
        lineComments: ["//"],
        blockComment: true,
        quotes: new Set(["'", "\"", "`"]),
        variables: true,
      });
    case "json":
      return highlightJson(line);
    case "markdown":
      return highlightMarkdown(line);
    case "markup":
      return highlightMarkup(line);
    case "python":
      return highlightCodeLike(line, {
        keywords: PYTHON_KEYWORDS,
        lineComments: ["#"],
        blockComment: false,
        quotes: new Set(["'", "\""]),
        variables: false,
      });
    case "shell":
      return highlightCodeLike(line, {
        keywords: SHELL_KEYWORDS,
        lineComments: ["#"],
        blockComment: false,
        quotes: new Set(["'", "\"", "`"]),
        variables: true,
      });
    case "sql":
      return highlightCodeLike(line, {
        keywords: SQL_KEYWORDS,
        lineComments: ["--"],
        blockComment: true,
        quotes: new Set(["'", "\""]),
        variables: false,
        caseInsensitive: true,
      });
    case "yaml":
      return highlightYaml(line);
    default:
      return highlightCodeLike(line, {
        keywords: new Set(),
        lineComments: ["#"],
        blockComment: true,
        quotes: new Set(["'", "\""]),
        variables: false,
      });
  }
}

function highlightCodeLike(
  line: string,
  options: {
    blockComment: boolean;
    caseInsensitive?: boolean;
    keywords: Set<string>;
    lineComments: string[];
    quotes: Set<string>;
    variables: boolean;
  },
): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  while (i < line.length) {
    const comment = options.lineComments.find((prefix) => line.startsWith(prefix, i));
    if (comment) {
      push(out, line.slice(i), "comment");
      break;
    }
    if (options.blockComment && line.startsWith("/*", i)) {
      const end = line.indexOf("*/", i + 2);
      const next = end === -1 ? line.length : end + 2;
      push(out, line.slice(i, next), "comment");
      i = next;
      continue;
    }

    const ch = line[i]!;
    if (options.quotes.has(ch)) {
      const next = scanString(line, i, ch);
      push(out, line.slice(i, next), "string");
      i = next;
      continue;
    }
    if (options.variables && ch === "$") {
      const variable = line.slice(i).match(/^\$[{(]?[A-Za-z_][\w-]*[})]?/);
      if (variable) {
        push(out, variable[0], "variable");
        i += variable[0].length;
        continue;
      }
    }
    if (isDigit(ch)) {
      const number = line.slice(i).match(/^(?:0x[\da-fA-F]+|\d+(?:\.\d+)?)(?:[eE][+-]?\d+)?\b/);
      if (number) {
        push(out, number[0], "number");
        i += number[0].length;
        continue;
      }
    }
    if (isIdentifierStart(ch)) {
      const word = readIdentifier(line, i);
      const lookup = options.caseInsensitive ? word.toLowerCase() : word;
      const nextNonSpace = line.slice(i + word.length).match(/^\s*(.)/)?.[1] ?? "";
      if (options.keywords.has(lookup) || options.keywords.has(word)) {
        push(out, word, keywordKind(word));
      } else if (nextNonSpace === "(") {
        push(out, word, "function");
      } else {
        push(out, word);
      }
      i += word.length;
      continue;
    }
    if (/[{}[\]().,;:]/.test(ch)) {
      push(out, ch, "punctuation");
      i += 1;
      continue;
    }
    if (/[+\-*/%=!<>|&?~^@]/.test(ch)) {
      const op = line.slice(i).match(/^[+\-*/%=!<>|&?~^@]+/)?.[0] ?? ch;
      push(out, op, "operator");
      i += op.length;
      continue;
    }
    push(out, ch);
    i += 1;
  }
  return out;
}

function highlightJson(line: string): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === "\"") {
      const next = scanString(line, i, "\"");
      const after = line.slice(next).trimStart();
      push(out, line.slice(i, next), after.startsWith(":") ? "property" : "string");
      i = next;
      continue;
    }
    if (isDigit(ch) || ch === "-") {
      const number = line.slice(i).match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/);
      if (number) {
        push(out, number[0], "number");
        i += number[0].length;
        continue;
      }
    }
    const literal = line.slice(i).match(/^(true|false|null)\b/);
    if (literal) {
      push(out, literal[0], "literal");
      i += literal[0].length;
      continue;
    }
    if (/[{}[\],:]/.test(ch)) {
      push(out, ch, "punctuation");
      i += 1;
      continue;
    }
    push(out, ch);
    i += 1;
  }
  return out;
}

function highlightCss(line: string): Segment[] {
  const property = line.match(/^(\s*)(-?[\w-]+)(\s*:)/);
  if (property) {
    return [
      { text: property[1] ?? "" },
      { text: property[2] ?? "", kind: "property" },
      { text: property[3] ?? "", kind: "punctuation" },
      ...highlightCssValue(line.slice(property[0].length)),
    ];
  }
  return highlightCssValue(line);
}

function highlightCssValue(line: string): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  while (i < line.length) {
    if (line.startsWith("/*", i)) {
      const end = line.indexOf("*/", i + 2);
      const next = end === -1 ? line.length : end + 2;
      push(out, line.slice(i, next), "comment");
      i = next;
      continue;
    }
    const ch = line[i]!;
    if (ch === "'" || ch === "\"") {
      const next = scanString(line, i, ch);
      push(out, line.slice(i, next), "string");
      i = next;
      continue;
    }
    const hex = line.slice(i).match(/^#[\da-fA-F]{3,8}\b/);
    if (hex) {
      push(out, hex[0], "number");
      i += hex[0].length;
      continue;
    }
    const atRule = line.slice(i).match(/^@[\w-]+/);
    if (atRule) {
      push(out, atRule[0], "keyword");
      i += atRule[0].length;
      continue;
    }
    const number = line.slice(i).match(/^\d+(?:\.\d+)?(?:px|rem|em|vh|vw|%|s|ms)?\b/);
    if (number) {
      push(out, number[0], "number");
      i += number[0].length;
      continue;
    }
    if (isIdentifierStart(ch)) {
      const word = readCssIdentifier(line, i);
      const nextNonSpace = line.slice(i + word.length).match(/^\s*(.)/)?.[1] ?? "";
      push(out, word, nextNonSpace === "(" ? "function" : undefined);
      i += word.length;
      continue;
    }
    if (/[{}[\]().,;:]/.test(ch)) {
      push(out, ch, "punctuation");
      i += 1;
      continue;
    }
    push(out, ch);
    i += 1;
  }
  return out;
}

function highlightMarkup(line: string): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  while (i < line.length) {
    if (line.startsWith("<!--", i)) {
      const end = line.indexOf("-->", i + 4);
      const next = end === -1 ? line.length : end + 3;
      push(out, line.slice(i, next), "comment");
      i = next;
      continue;
    }
    const tagStart = line.indexOf("<", i);
    if (tagStart === -1) {
      push(out, line.slice(i));
      break;
    }
    if (tagStart > i) push(out, line.slice(i, tagStart));
    const tagEnd = line.indexOf(">", tagStart + 1);
    const next = tagEnd === -1 ? line.length : tagEnd + 1;
    out.push(...highlightTag(line.slice(tagStart, next)));
    i = next;
  }
  return out;
}

function highlightTag(raw: string): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch === "<" || ch === ">" || ch === "/" || ch === "=") {
      push(out, ch, "punctuation");
      i += 1;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      const next = scanString(raw, i, ch);
      push(out, raw.slice(i, next), "string");
      i = next;
      continue;
    }
    if (isIdentifierStart(ch)) {
      const word = readCssIdentifier(raw, i);
      const previous = raw.slice(0, i).trimEnd();
      push(out, word, previous.endsWith("<") || previous.endsWith("</") ? "tag" : "attr");
      i += word.length;
      continue;
    }
    push(out, ch);
    i += 1;
  }
  return out;
}

function highlightMarkdown(line: string): Segment[] {
  const heading = line.match(/^(#{1,6})(\s.*)$/);
  if (heading) {
    return [
      { text: heading[1] ?? "", kind: "meta" },
      { text: heading[2] ?? "", kind: "keyword" },
    ];
  }
  const fence = line.match(/^(\s*)(```.*)$/);
  if (fence) {
    return [
      { text: fence[1] ?? "" },
      { text: fence[2] ?? "", kind: "meta" },
    ];
  }
  const bullet = line.match(/^(\s*)([-*+]|\d+\.)(\s+)/);
  const prefix: Segment[] = bullet
    ? [
        { text: bullet[1] ?? "" },
        { text: bullet[2] ?? "", kind: "meta" },
        { text: bullet[3] ?? "" },
      ]
    : [];
  const rest = bullet ? line.slice(bullet[0].length) : line;
  return [...prefix, ...highlightInlineMarkdown(rest)];
}

function highlightInlineMarkdown(line: string): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === "`") {
      const end = line.indexOf("`", i + 1);
      const next = end === -1 ? line.length : end + 1;
      push(out, line.slice(i, next), "string");
      i = next;
      continue;
    }
    const link = line.slice(i).match(/^\[[^\]]+\]\([^)]+\)/);
    if (link) {
      push(out, link[0], "function");
      i += link[0].length;
      continue;
    }
    const emphasis = line.slice(i).match(/^(\*\*[^*]+\*\*|\*[^*]+\*)/);
    if (emphasis) {
      push(out, emphasis[0], "keyword");
      i += emphasis[0].length;
      continue;
    }
    push(out, line[i]!);
    i += 1;
  }
  return out;
}

function highlightYaml(line: string): Segment[] {
  const commentIndex = findUnquotedComment(line, "#");
  const code = commentIndex === -1 ? line : line.slice(0, commentIndex);
  const comment = commentIndex === -1 ? "" : line.slice(commentIndex);
  const key = code.match(/^(\s*)([^:#]+)(\s*:)/);
  const segments: Segment[] = [];
  if (key) {
    segments.push(
      { text: key[1] ?? "" },
      { text: key[2] ?? "", kind: "property" },
      { text: key[3] ?? "", kind: "punctuation" },
      ...highlightCodeLike(code.slice(key[0].length), {
        keywords: new Set(["true", "false", "null"]),
        lineComments: [],
        blockComment: false,
        quotes: new Set(["'", "\""]),
        variables: false,
      }),
    );
  } else {
    segments.push(...highlightCodeLike(code, {
      keywords: new Set(["true", "false", "null"]),
      lineComments: [],
      blockComment: false,
      quotes: new Set(["'", "\""]),
      variables: false,
    }));
  }
  if (comment) push(segments, comment, "comment");
  return segments;
}

function scanString(line: string, start: number, quote: string) {
  let i = start + 1;
  while (i < line.length) {
    if (line[i] === "\\") {
      i += 2;
      continue;
    }
    if (line[i] === quote) return i + 1;
    i += 1;
  }
  return line.length;
}

function findUnquotedComment(line: string, marker: string) {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      continue;
    }
    if (line.startsWith(marker, i)) return i;
  }
  return -1;
}

function keywordKind(word: string): TokenKind {
  if (["true", "false", "null", "undefined", "None", "True", "False"].includes(word)) return "literal";
  return "keyword";
}

function readIdentifier(line: string, start: number) {
  const match = line.slice(start).match(/^[A-Za-z_$][\w$-]*/);
  return match?.[0] ?? line[start] ?? "";
}

function readCssIdentifier(line: string, start: number) {
  const match = line.slice(start).match(/^[A-Za-z_:-][\w:.-]*/);
  return match?.[0] ?? line[start] ?? "";
}

function isIdentifierStart(ch: string) {
  return /[A-Za-z_$]/.test(ch);
}

function isDigit(ch: string) {
  return /\d/.test(ch);
}

function push(out: Segment[], text: string, kind?: TokenKind) {
  if (!text) return;
  const prev = out.at(-1);
  if (prev && prev.kind === kind) {
    prev.text += text;
    return;
  }
  out.push(kind ? { text, kind } : { text });
}
