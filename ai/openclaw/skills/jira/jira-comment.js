const fs = require('fs');
const self = require('../agent-self');
const { jiraRequest } = require('./lib');

// ─── Markdown → ADF ─────────────────────────────────────────────────────────
//
// Minimal markdown parser sufficient for human-written replies. Supports:
//   block: paragraphs (split on blank line), ATX headings (#/##/###),
//          bullet lists (- / *), ordered lists (1.), fenced code (```lang),
//          pipe tables.
//   inline: **bold**, *italic*, `code`, [text](url).
//
// A trailing signature block — the last three non-blank lines being:
//     --
//     <First Name>
//     <provider>/<model>
// — is detected and rendered as three short paragraphs, with the provider/
// model line styled subdued via subsup{type:sub}+textColor{#999999}.

const INLINE_PATTERNS = [
  { name: 'link',   re: /\[([^\]]+)\]\(([^)\s]+)\)/ },
  { name: 'bold',   re: /\*\*([^*]+)\*\*/ },
  { name: 'code',   re: /`([^`\n]+)`/ },
  { name: 'italic', re: /(?:^|[^*])\*([^*\n]+)\*(?!\*)/ },
];

function mentionAliases() {
  const aliases = [];
  for (const agent of (self.registry.agents || [])) {
    if (!agent.jira_account_id) continue;
    const labels = new Set([
      agent.user,
      agent.name,
      (agent.name || '').split(/\s+/)[0],
    ].filter(Boolean));
    for (const label of labels) {
      aliases.push({
        label,
        lower: label.toLowerCase(),
        accountId: agent.jira_account_id,
        text: `@${agent.name || agent.user}`,
      });
    }
  }
  return aliases.sort((a, b) => b.lower.length - a.lower.length);
}

const MENTION_ALIASES = mentionAliases();

function lookupMention(label) {
  const key = String(label || '').trim().toLowerCase();
  return MENTION_ALIASES.find(a => a.lower === key) || null;
}

function findMention(str) {
  const bracket = /@\[(.+?)\]/.exec(str);
  let best = null;
  if (bracket) {
    const alias = lookupMention(bracket[1]);
    if (alias) best = {
      index: bracket.index,
      length: bracket[0].length,
      alias,
    };
  }

  for (const alias of MENTION_ALIASES) {
    const needle = `@${alias.lower}`;
    const haystack = str.toLowerCase();
    let pos = haystack.indexOf(needle);
    while (pos !== -1) {
      const before = pos === 0 ? '' : str[pos - 1];
      const after = str[pos + needle.length] || '';
      const validBefore = !before || /[\s([{:>,-]/.test(before);
      const validAfter = !after || /[\s.,;:!?)}\]-]/.test(after);
      if (validBefore && validAfter && (!best || pos < best.index)) {
        best = { index: pos, length: needle.length, alias };
        break;
      }
      pos = haystack.indexOf(needle, pos + 1);
    }
  }
  return best;
}

function mentionNode(alias) {
  return {
    type: 'mention',
    attrs: {
      id: alias.accountId,
      text: alias.text,
      accessLevel: '',
    },
  };
}

function inlineToNodes(str, marks = []) {
  if (!str) return [];

  let earliest = null;
  const mention = marks.length ? null : findMention(str);
  if (mention) {
    earliest = {
      p: { name: 'mention' },
      m: {
        index: mention.index,
        0: str.slice(mention.index, mention.index + mention.length),
        mention,
      },
    };
  }
  for (const p of INLINE_PATTERNS) {
    const m = p.re.exec(str);
    if (m && (!earliest || m.index < earliest.m.index)) {
      earliest = { p, m };
    }
  }
  if (!earliest) {
    return [{ type: 'text', text: str, ...(marks.length ? { marks } : {}) }];
  }

  const { p, m } = earliest;
  let matchStart = m.index;
  const matchEnd = m.index + m[0].length;
  const captured = m[1];
  let href = null;
  if (p.name === 'italic' && m[0].length && /[^*]/.test(m[0][0])) {
    matchStart += 1;
  } else if (p.name === 'link') {
    href = m[2];
  }

  const before = str.slice(0, matchStart);
  const after = str.slice(matchEnd);

  const out = [];
  if (before) out.push(...inlineToNodes(before, marks));

  if (p.name === 'code') {
    out.push({ type: 'text', text: captured, marks: [...marks, { type: 'code' }] });
  } else if (p.name === 'bold') {
    out.push(...inlineToNodes(captured, [...marks, { type: 'strong' }]));
  } else if (p.name === 'italic') {
    out.push(...inlineToNodes(captured, [...marks, { type: 'em' }]));
  } else if (p.name === 'link') {
    out.push(...inlineToNodes(captured, [...marks, { type: 'link', attrs: { href } }]));
  } else if (p.name === 'mention') {
    out.push(mentionNode(m.mention.alias));
  }

  out.push(...inlineToNodes(after, marks));
  return out;
}

function paragraphNode(text) {
  const nodes = [];
  text.split('\n').forEach((line, i) => {
    if (i > 0) nodes.push({ type: 'hardBreak' });
    nodes.push(...inlineToNodes(line));
  });
  return { type: 'paragraph', content: nodes };
}

function headingNode(level, text) {
  return { type: 'heading', attrs: { level }, content: inlineToNodes(text) };
}

function codeBlockNode(language, text) {
  const block = { type: 'codeBlock', attrs: language ? { language } : {} };
  if (text) block.content = [{ type: 'text', text }];
  return block;
}

function bulletListNode(items) {
  return {
    type: 'bulletList',
    content: items.map(t => ({ type: 'listItem', content: [paragraphNode(t)] })),
  };
}

function orderedListNode(items) {
  return {
    type: 'orderedList',
    attrs: { order: 1 },
    content: items.map(t => ({ type: 'listItem', content: [paragraphNode(t)] })),
  };
}

function tableNode(rows) {
  const buildRow = (cells, isHeader) => ({
    type: 'tableRow',
    content: cells.map(c => ({
      type: isHeader ? 'tableHeader' : 'tableCell',
      attrs: {},
      content: [paragraphNode(c)],
    })),
  });
  return {
    type: 'table',
    attrs: { isNumberColumnEnabled: false, layout: 'default' },
    content: rows.map((r, i) => buildRow(r, i === 0)),
  };
}

const isBullet  = l => /^[-*]\s+/.test(l);
const isOrdered = l => /^\d+\.\s+/.test(l);
const isHeading = l => /^#{1,3}\s+/.test(l);
const isFence   = l => /^```/.test(l);
const isTableRow = l => /^\|.*\|\s*$/.test(l);
const isTableSep = l => /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(l);

function parseBlocks(md) {
  const lines = md.split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }

    if (isFence(line)) {
      const lang = line.slice(3).trim();
      const buf = [];
      i++;
      while (i < lines.length && !isFence(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      blocks.push(codeBlockNode(lang, buf.join('\n')));
      continue;
    }

    const h = /^(#{1,3})\s+(.+)$/.exec(line);
    if (h) {
      blocks.push(headingNode(h[1].length, h[2].trim()));
      i++; continue;
    }

    if (isBullet(line)) {
      const items = [];
      while (i < lines.length && isBullet(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s+/, '')); i++;
      }
      blocks.push(bulletListNode(items));
      continue;
    }

    if (isOrdered(line)) {
      const items = [];
      while (i < lines.length && isOrdered(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, '')); i++;
      }
      blocks.push(orderedListNode(items));
      continue;
    }

    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const cells = l => l.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const rows = [cells(line)];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) { rows.push(cells(lines[i])); i++; }
      blocks.push(tableNode(rows));
      continue;
    }

    const buf = [line]; i++;
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === '') break;
      if (isBullet(l) || isOrdered(l) || isHeading(l) || isFence(l) || isTableRow(l)) break;
      buf.push(l); i++;
    }
    blocks.push(paragraphNode(buf.join('\n')));
  }

  return blocks;
}

function splitSignature(md) {
  const trimmed = (md || '').replace(/\s+$/, '');
  if (!trimmed) return { body: '', sig: null };
  const lines = trimmed.split('\n');
  const idx = [];
  for (let i = lines.length - 1; i >= 0 && idx.length < 3; i--) {
    if (lines[i].trim() !== '') idx.unshift(i);
  }
  if (idx.length < 3) return { body: trimmed, sig: null };
  const [a, b, c] = idx.map(j => lines[j]);
  if (a.trim() !== '--') return { body: trimmed, sig: null };
  if (!c.includes('/')) return { body: trimmed, sig: null };
  const bodyLines = lines.slice(0, idx[0]);
  while (bodyLines.length && bodyLines[bodyLines.length - 1].trim() === '') bodyLines.pop();
  return { body: bodyLines.join('\n'), sig: { name: b.trim(), providerModel: c.trim() } };
}

function signatureBlocks(sig) {
  return [
    { type: 'paragraph', content: [{ type: 'text', text: '--' }] },
    { type: 'paragraph', content: [{ type: 'text', text: sig.name }] },
    {
      type: 'paragraph',
      content: [{
        type: 'text',
        text: sig.providerModel,
        marks: [
          { type: 'subsup', attrs: { type: 'sub' } },
          { type: 'textColor', attrs: { color: '#999999' } },
        ],
      }],
    },
  ];
}

function markdownToAdf(md) {
  const { body, sig } = splitSignature(md || '');
  const content = parseBlocks(body);
  if (sig) content.push(...signatureBlocks(sig));
  if (!content.length) content.push({ type: 'paragraph', content: [] });
  return { type: 'doc', version: 1, content };
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function usage(extra) {
  if (extra) console.error(extra + '\n');
  console.error('Usage:');
  console.error('  node jira-comment.js <ISSUE-KEY> "Markdown comment text"');
  console.error('  node jira-comment.js <ISSUE-KEY> --body-file=<path>');
  console.error('  node jira-comment.js <ISSUE-KEY> -                       # body from stdin');
  console.error('');
  console.error('Pass the actual comment text, --body-file=<path> to load it');
  console.error('from a file, or "-" to read from stdin. NEVER pass a bare');
  console.error('path as the comment — that would post the literal path text.');
  process.exit(1);
}

// Same body-arg conventions as gmail-send.js / gmail-reply.js so agents
// have one consistent pattern across senders. Path-guard refuses to post
// a malformed comment when the body looks like a bare file path.
function parseBodyArgs(argv) {
  const positional = [];
  let bodyFile = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--body-file' || a === '-f') {
      bodyFile = argv[++i];
      if (!bodyFile) usage('--body-file requires a path');
    } else if (a.startsWith('--body-file=')) {
      bodyFile = a.slice('--body-file='.length);
    } else {
      positional.push(a);
    }
  }
  return { positional, bodyFile };
}

async function main() {
  const { positional, bodyFile } = parseBodyArgs(process.argv.slice(2));
  const [issueKey, ...rest] = positional;
  if (!issueKey) usage('missing <ISSUE-KEY>');

  let comment;
  if (bodyFile) {
    if (!fs.existsSync(bodyFile)) usage(`--body-file path does not exist: ${bodyFile}`);
    comment = fs.readFileSync(bodyFile, 'utf8').trim();
  } else if (rest.length === 1 && rest[0] === '-') {
    comment = fs.readFileSync(0, 'utf8').trim();
  } else if (rest.length === 0) {
    usage('missing <comment text>');
  } else {
    const raw = rest.join(' ').trim();
    // Path-guard: refuse to post a bare path as the comment text —
    // agent almost certainly meant --body-file. This is the bug that
    // produced "barekbaal posted '--body-file' as the literal comment".
    if (rest.length === 1
        && /^\/[^\s]+$/.test(raw)
        && fs.existsSync(raw)
        && fs.statSync(raw).isFile()) {
      usage(
        `Comment "${raw}" looks like a path to an existing file. ` +
        `Use --body-file=${raw} to post the file contents, or pass ` +
        `the actual markdown comment as a literal string.`
      );
    }
    // Also reject a bare flag stub like "--body-file" with no path —
    // that's how the original bug surfaced (literal "--body-file"
    // ended up as the comment body).
    if (/^--?body-file=?$/.test(raw)) {
      usage(
        `Comment "${raw}" looks like an incomplete --body-file flag. ` +
        `Did you mean --body-file=<path>?`
      );
    }
    comment = raw;
  }
  if (!comment) usage('missing <comment text>');

  try {
    const adf = markdownToAdf(comment);
    const result = await jiraRequest(`/issue/${issueKey}/comment`, {
      method: 'POST',
      body: JSON.stringify({ body: adf }),
    });

    console.log(JSON.stringify({
      success: true,
      commentId: result.id,
      issueKey,
      url: `https://zeh-ferrari.atlassian.net/browse/${issueKey}?focusedCommentId=${result.id}`,
    }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }, null, 2));
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { markdownToAdf, splitSignature };
