export function isNonRepositoryGitStderr(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return (
    normalized.includes("not a git repository") ||
    normalized.includes("gitfile does not point to a valid repository")
  );
}
