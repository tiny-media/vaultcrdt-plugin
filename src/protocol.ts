export const PROTOCOL_VERSION = 1;

/**
 * `requestUrl().json` is typed `any` by the Obsidian API. Narrow it once at the
 * boundary so call sites work with a declared shape instead of `any`.
 */
export function jsonOf<T>(resp: { json?: Partial<T> }): Partial<T> {
  return resp.json ?? {};
}
