import path from "node:path";

/**
 * Normalize a local path for identity comparisons without changing the path
 * returned to callers. POSIX path identity preserves letter case.
 */
export function normalizedPathIdentity(value: string): string {
  return path.resolve(value);
}

export function sameResolvedPath(left: string, right: string): boolean {
  return normalizedPathIdentity(left) === normalizedPathIdentity(right);
}

/**
 * Lexically test whether target is root itself or a descendant. A child named
 * "..cache" is valid; only the actual ".." path segment escapes the root.
 */
export function isPathInside(root: string, target: string): boolean {
  const normalizedRoot = normalizedPathIdentity(root);
  const normalizedTarget = normalizedPathIdentity(target);
  const relative = path.relative(normalizedRoot, normalizedTarget);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}