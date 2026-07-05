import { renderChatMarkdown, renderFullMarkdown } from "../lib/markdown";

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

const youtubeUrl = "https://www.youtube.com/watch?v=EZcLACNoDfo";

for (const [name, render] of [
  ["chat", renderChatMarkdown],
  ["full", renderFullMarkdown],
] as const) {
  const linked = render(`[Video](${youtubeUrl})`).__html;
  assert(linked.includes(`href="${youtubeUrl}"`), `${name} markdown must preserve YouTube href`);
  assert(linked.includes('target="_blank"'), `${name} markdown must open external links in a new tab`);
  assert(linked.includes('rel="noreferrer noopener"'), `${name} markdown must protect external links`);

  const unsafe = render("[bad](javascript:alert(1))").__html;
  assert(!unsafe.includes("href=\"javascript:"), `${name} markdown must not emit javascript links`);
}

console.log("markdown link rendering ok");
