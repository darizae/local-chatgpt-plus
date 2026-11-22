export interface SafeSpawnSpec {
  file: string;
  args: string[];
  resolved_executable: string;
  shim?: string;
}

/** macOS: spawn executable directly without a command shell or shell interpolation. */
export async function resolveSafeSpawnSpec(
  command: string,
  args: string[],
  _env?: NodeJS.ProcessEnv,
): Promise<SafeSpawnSpec> {
  return { file: command, args: [...args], resolved_executable: command };
}