export function isNotGitRepositoryMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("not a git repository") ||
    normalized.includes("does not point to a valid repository")
  );
}
