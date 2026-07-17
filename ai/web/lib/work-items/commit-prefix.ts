/**
 * A commit prefix must be a complete leading token, not merely a string
 * prefix. This keeps human keys such as V23-3 from matching V23-30.
 */
export function subjectHasCommitPrefix(subject: string, prefix: string) {
  const required = prefix.trim();
  if (!required || !subject.startsWith(required)) return false;
  const boundary = subject.slice(required.length, required.length + 1);
  return boundary === "" || boundary === ":" || /\s/.test(boundary);
}
