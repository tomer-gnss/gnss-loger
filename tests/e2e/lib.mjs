// Shared paths for the browser suites. Each suite is a plain Node script:
//   node tests/e2e/<suite>.e2e.mjs <BASE-URL>
// prints PASS/FAIL lines and "N/M passed", and exits non-zero on failure. run.mjs runs them all.
import { fileURLToPath } from 'node:url'

/** tests/.generated/ (forward slashes, trailing slash): samples/, attack/, out/. */
export const GEN = fileURLToPath(new URL('../.generated/', import.meta.url)).replace(/\\/g, '/')
