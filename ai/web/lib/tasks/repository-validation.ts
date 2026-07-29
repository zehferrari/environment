const SEMANTIC_STOP_WORDS = new Set([
  "about", "after", "again", "also", "and", "before", "branch", "change",
  "changes", "commit", "from", "have", "into", "project", "repository",
  "should", "task", "that", "the", "this", "update", "with",
]);

function semanticTokens(value: string) {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 3 && !SEMANTIC_STOP_WORDS.has(token)),
  );
}

export function semanticCommitDescriptionWarning(args: {
  taskTitle: string | null | undefined;
  taskDescription?: string | null;
  commitPrefix?: string | null;
  commitSubject: string | null | undefined;
}) {
  if (!args.commitSubject || !args.taskTitle) return null;
  const requestTokens = semanticTokens(`${args.taskTitle}\n${args.taskDescription ?? ""}`);
  const subjectWithoutPrefix =
    args.commitPrefix && args.commitSubject.startsWith(args.commitPrefix)
      ? args.commitSubject.slice(args.commitPrefix.length)
      : args.commitSubject;
  const subjectTokens = semanticTokens(subjectWithoutPrefix);
  if (requestTokens.size === 0 || subjectTokens.size === 0) {
    return "The commit description does not provide enough task-specific detail to confirm that it matches the task request.";
  }
  const overlap = [...subjectTokens].filter((token) => requestTokens.has(token));
  if (overlap.length > 0) return null;
  return [
    `The commit description \`${args.commitSubject}\` does not clearly match the task request \`${args.taskTitle}\`.`,
    "Repository validation still passed. This is advisory; the reviewer must decide whether the implementation is acceptable.",
  ].join(" ");
}

export function isOperationalRepositoryFailure(value: string | null | undefined) {
  return Boolean(value && /authentication|authorization|credentials?|connection|connectivity|could not resolve|network is unreachable|timed out|temporary failure|service unavailable|database is locked|read-only file system|permission denied|unauthorized|git fetch\b.*failed|git push\b.*failed|pushing .*\bfailed/i.test(value));
}
