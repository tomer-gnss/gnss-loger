// Lets Node run the app's TypeScript sources directly in tests: the sources import each other
// without extensions (`./logParser`), as the bundler allows. Node 24 strips the types itself;
// this hook only adds the missing `.ts` / `.tsx` (or `/index.ts` for a folder). Used via `node --import ./tests/resolve-ts.mjs`.
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context)
    } catch (err) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../')
      if (!relative || /\.[cm]?[jt]sx?$/.test(specifier)) throw err
      for (const ext of ['.ts', '.tsx', '/index.ts']) {
        try {
          return next(specifier + ext, context)
        } catch {
          /* try the next extension */
        }
      }
      throw err
    }
  },
})
