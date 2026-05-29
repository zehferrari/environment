const SECTION_A_TITLE = "Section A - Full Response";
const SECTION_B_TITLE = "Section B - Short Summary";

export const DISCUSSION_REPLY_FORMAT_PROMPT = [
  "For visible replies in this Discussion, always return exactly two markdown sections:",
  `## ${SECTION_A_TITLE}`,
  "Put your complete, final, fully formatted answer here.",
  "",
  `## ${SECTION_B_TITLE}`,
  "Put a short, direct summary here: a few concise paragraphs focused on the human's latest request.",
  "",
  "Do not add text before Section A or after Section B.",
].join("\n");

export interface DiscussionReplySections {
  sectionA: string;
  sectionB: string;
}

function cleanHeadingText(line: string) {
  return line
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[*_`]+|[*_`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function headingFor(line: string): "a" | "b" | null {
  const text = cleanHeadingText(line);
  if (/^section\s*a\b/.test(text) || /^a\s*[:.)-]/.test(text)) return "a";
  if (/^section\s*b\b/.test(text) || /^b\s*[:.)-]/.test(text)) return "b";
  return null;
}

export function parseDiscussionReplySections(input: string): DiscussionReplySections | null {
  const text = input.replace(/\r\n/g, "\n").trim();
  if (!text) return null;

  const lines = text.split("\n");
  const sectionAIndex = lines.findIndex((line) => headingFor(line) === "a");
  const sectionBIndex = lines.findIndex((line, index) => (
    (sectionAIndex < 0 || index > sectionAIndex) && headingFor(line) === "b"
  ));

  if (sectionBIndex < 0) return null;

  const sectionA = lines
    .slice(sectionAIndex >= 0 ? sectionAIndex + 1 : 0, sectionBIndex)
    .join("\n")
    .trim();
  const sectionB = lines.slice(sectionBIndex + 1).join("\n").trim();

  if (!sectionA || !sectionB) return null;
  return { sectionA, sectionB };
}

export function extractDiscussionSectionA(input: string): string {
  const text = input.replace(/\r\n/g, "\n").trim();
  if (!text) return "";

  const parsed = parseDiscussionReplySections(text);
  if (parsed) return parsed.sectionA;

  const lines = text.split("\n");
  const sectionAIndex = lines.findIndex((line) => headingFor(line) === "a");
  const sectionBIndex = lines.findIndex((line, index) => (
    (sectionAIndex < 0 || index > sectionAIndex) && headingFor(line) === "b"
  ));

  if (sectionAIndex >= 0) {
    const end = sectionBIndex >= 0 ? sectionBIndex : lines.length;
    return lines.slice(sectionAIndex + 1, end).join("\n").trim() || text;
  }
  if (sectionBIndex >= 0) return lines.slice(0, sectionBIndex).join("\n").trim() || text;
  return text;
}

function truncateAtSentence(value: string, max: number) {
  if (value.length <= max) return value;
  const sliced = value.slice(0, max - 1).trimEnd();
  const sentenceBreak = Math.max(
    sliced.lastIndexOf(". "),
    sliced.lastIndexOf("! "),
    sliced.lastIndexOf("? "),
  );
  const wordBreak = sliced.lastIndexOf(" ");
  const cutAt = sentenceBreak > Math.floor(max * 0.45)
    ? sentenceBreak + 1
    : wordBreak > Math.floor(max * 0.45)
      ? wordBreak
      : sliced.length;
  return `${sliced.slice(0, cutAt).trimEnd()}...`;
}

function fallbackSummary(input: string) {
  const paragraphs = input
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0 && headingFor(paragraph) === null);
  const source = paragraphs.slice(0, 2).join("\n\n") || input.trim();
  return truncateAtSentence(source, 700);
}

export function formatDiscussionReplySections(sectionA: string, sectionB: string) {
  return [
    `## ${SECTION_A_TITLE}`,
    sectionA.trim(),
    "",
    `## ${SECTION_B_TITLE}`,
    sectionB.trim(),
  ].join("\n");
}

export function normalizeDiscussionReplySections(input: string) {
  const text = input.trim();
  const parsed = parseDiscussionReplySections(text);
  if (parsed) return formatDiscussionReplySections(parsed.sectionA, parsed.sectionB);
  return formatDiscussionReplySections(text, fallbackSummary(text));
}
