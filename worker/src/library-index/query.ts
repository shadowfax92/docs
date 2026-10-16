import type { LibraryDependencies, LibraryQueries } from "./contracts";
import { unavailable } from "./contracts";

/** Query owner replaces these stubs with D1 pages, exact counts, progressive slices and snippets.
 * Cursor parsing/generation binding and all body read caps stay private to this implementation.
 */
export function createLibraryQueries(_deps: LibraryDependencies): LibraryQueries {
  return {
    async page() { return unavailable("metadata pages"); },
    async search() { return unavailable("search"); },
    async snippets() { return unavailable("snippets"); },
  };
}
