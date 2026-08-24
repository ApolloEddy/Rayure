/**
 * Explicit browser-only replacements for optional Node branches in third-party
 * modules.  Wallpaper Engine runs a Chromium renderer, never a Node runtime;
 * these functions are therefore defensive diagnostics rather than polyfills.
 */
export async function readFile(..._arguments: readonly unknown[]): Promise<never> {
  throw new Error('node:fs/promises is unavailable in the Wallpaper Engine renderer')
}

export function fileURLToPath(..._arguments: readonly unknown[]): never {
  throw new Error('node:url is unavailable in the Wallpaper Engine renderer')
}
