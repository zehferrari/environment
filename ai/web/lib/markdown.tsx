// Comment-body renderer (HOMELAB-44 Stage 2).
// Treats input as plain text and produces React nodes — never returns
// HTML strings — so the input is XSS-safe by construction (textual
// content goes through React's normal escaping).
//
// Supported markdown (intentionally narrow for v1):
//   block:  paragraph (split on blank line); newlines inside a paragraph
//           become <br>.
//   inline: **bold**, *italic*, `code`, [text](href).
//   mentions: @username, only when `username` matches a known
//             Mentionable (exact match, case-sensitive).
//
// Anything fancier (lists, headings, fenced code blocks) is intentionally
// left for a later slice — the goal here is "comments are readable and
// have working mentions", not "ship a markdown engine".

import type { ReactNode } from "react";

export interface Mentionable {
  username: string;
}

interface InlinePattern {
  name: "bold" | "italic" | "code" | "link" | "mention";
  re: RegExp;
}

// Order matters when two patterns could fire at the same index: scan
// finds the earliest match, ties broken by array order (bold before
// italic so `**x**` isn't eaten by the italic rule).
const INLINE_PATTERNS: InlinePattern[] = [
  { name: "code", re: /`([^`\n]+)`/ },
  { name: "bold", re: /\*\*([^*\n]+)\*\*/ },
  { name: "italic", re: /(^|[^*])\*([^*\n]+)\*(?!\*)/ },
  { name: "link", re: /\[([^\]\n]+)\]\(([^)\s]+)\)/ },
  { name: "mention", re: /(^|[^A-Za-z0-9_])@([A-Za-z0-9_]{1,64})/ },
];

// Link href allowlist for v1. React JSX escaping protects against HTML
// injection of the surrounding markup, but it does not neutralise
// dangerous URL schemes (javascript:, data:, vbscript:, etc.) on an
// anchor's href — those still execute on click. Restrict to schemes
// that cannot script: http(s), root-relative, in-page anchors, mailto.
// Everything else falls through to literal text in renderInline.
function isSafeHref(href: string): boolean {
  if (href.length === 0) return false;
  // Protocol-relative ("//foo") is ambiguous and uncommon in comments;
  // treat as unsafe so we don't inherit http:/https: at runtime.
  if (href.startsWith("//")) return false;
  if (href.startsWith("/")) return true;
  if (href.startsWith("#")) return true;
  if (/^https?:\/\//i.test(href)) return true;
  if (/^mailto:[^\s]+@[^\s]+$/i.test(href)) return true;
  return false;
}

function renderInline(
  text: string,
  mentionables: ReadonlySet<string>,
  keyPrefix: string,
): ReactNode[] {
  const out: ReactNode[] = [];
  let cursor = 0;
  let keyN = 0;

  while (cursor < text.length) {
    const slice = text.slice(cursor);

    // Find the earliest matching pattern in `slice`.
    let best: { p: InlinePattern; m: RegExpExecArray } | null = null;
    for (const p of INLINE_PATTERNS) {
      const m = p.re.exec(slice);
      if (!m) continue;
      if (!best || m.index < best.m.index) best = { p, m };
    }
    if (!best) {
      out.push(slice);
      break;
    }

    const { p, m } = best;
    // `tokenStart` is where the styled token actually begins inside
    // `slice` (i.e. past any non-greedy lead char that italic/mention
    // pin against). Unmatched text up to tokenStart is emitted exactly
    // once, immediately before the styled node.
    let tokenStart = m.index;
    const matchEnd = m.index + m[0].length;
    let inner: ReactNode;
    const k = `${keyPrefix}-${keyN++}`;

    switch (p.name) {
      case "code":
        inner = (
          <code
            key={k}
            className="rounded bg-[var(--color-panel-soft)] px-1 py-0.5 text-[0.875em] font-mono"
          >
            {m[1]}
          </code>
        );
        break;
      case "bold":
        inner = <strong key={k}>{m[1]}</strong>;
        break;
      case "italic": {
        // italic pattern keeps the preceding non-* char in m[1]; the
        // styled span begins at the actual `*`, after that lead char.
        // The lead char is preserved as part of slice.slice(0,
        // tokenStart) below, so we deliberately do NOT push it again
        // here (see HOMELAB-44 review commentId 12219).
        tokenStart += m[1].length;
        inner = <em key={k}>{m[2]}</em>;
        break;
      }
      case "link": {
        const href = m[2];
        if (!isSafeHref(href)) {
          // Unsafe scheme — preserve the literal source so the reader
          // can still see the intent, but don't render a live link.
          if (tokenStart > 0) out.push(slice.slice(0, tokenStart));
          out.push(`[${m[1]}](${href})`);
          cursor += matchEnd;
          continue;
        }
        inner = (
          <a
            key={k}
            href={href}
            className="underline decoration-dotted hover:text-[var(--color-accent)]"
            rel="noreferrer noopener"
            target={/^https?:\/\//i.test(href) ? "_blank" : undefined}
          >
            {m[1]}
          </a>
        );
        break;
      }
      case "mention": {
        const username = m[2];
        // mention pattern pins the preceding non-word char in m[1];
        // same lead-preservation contract as italic above.
        tokenStart += m[1].length;
        if (mentionables.has(username)) {
          inner = (
            <span
              key={k}
              className="rounded bg-[var(--color-panel-soft)] px-1 py-0.5 text-[var(--color-accent)] font-medium"
            >
              @{username}
            </span>
          );
        } else {
          // Unknown mention — leave the literal text in so it's not
          // visually misleading (no styled badge for a typo). Push the
          // unmatched lead-up text first so it isn't dropped.
          if (tokenStart > 0) out.push(slice.slice(0, tokenStart));
          out.push(`@${username}`);
          cursor += matchEnd;
          continue;
        }
        break;
      }
    }

    if (tokenStart > 0) out.push(slice.slice(0, tokenStart));
    out.push(inner);
    cursor += matchEnd;
  }

  return out;
}

function paragraphNodes(
  paragraph: string,
  mentionables: ReadonlySet<string>,
  keyPrefix: string,
): ReactNode[] {
  // Preserve in-paragraph newlines as <br>.
  const lines = paragraph.split("\n");
  const out: ReactNode[] = [];
  lines.forEach((line, i) => {
    out.push(...renderInline(line, mentionables, `${keyPrefix}-l${i}`));
    if (i < lines.length - 1) out.push(<br key={`${keyPrefix}-br${i}`} />);
  });
  return out;
}

// Top-level entry point. Returns an array of <p> elements (one per
// blank-line-separated paragraph). Caller wraps in a container element.
export function renderCommentBody(
  body: string,
  mentionables: ReadonlyArray<Mentionable>,
): ReactNode[] {
  const set = new Set(mentionables.map((m) => m.username));
  const paragraphs = body
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  return paragraphs.map((p, i) => (
    <p key={`p${i}`} className="mb-2 last:mb-0 leading-relaxed">
      {paragraphNodes(p, set, `p${i}`)}
    </p>
  ));
}

// Extract usernames mentioned in `body` that exist in `mentionables`.
// Useful for downstream notifications (not wired yet, but exposed so
// future slices can hook in without re-parsing).
export function extractMentions(
  body: string,
  mentionables: ReadonlyArray<Mentionable>,
): string[] {
  const set = new Set(mentionables.map((m) => m.username));
  const found = new Set<string>();
  const re = /(^|[^A-Za-z0-9_])@([A-Za-z0-9_]{1,64})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (set.has(m[2])) found.add(m[2]);
  }
  return [...found];
}
