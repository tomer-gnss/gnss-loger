// Trusted Types: with `require-trusted-types-for 'script'` in the CSP, the browser refuses every
// raw string assigned to an HTML sink (innerHTML, outerHTML, insertAdjacentHTML, …) unless it
// passes through a policy. This app's own code never does that (React renders text safely);
// the only HTML-sink user is Leaflet, with fixed strings (zoom buttons, attribution, feature tests).
//
// The default policy lets markup through only if it carries no script vector, and refuses
// scripts and script URLs outright. Must be imported before any other module.

type TT = { createPolicy: (name: string, rules: Record<string, (s: string) => string>) => unknown }

const SCRIPT_VECTOR = /<\s*(script|iframe|object|embed|link|meta|base|form|style|template)\b|\bon[a-z]+\s*=|javascript:|srcdoc|data:\s*text\/html/i

const tt = (globalThis as { trustedTypes?: TT }).trustedTypes
if (tt) {
  try {
    tt.createPolicy('default', {
      createHTML: (s: string) => {
        if (SCRIPT_VECTOR.test(s)) throw new TypeError('Blocked by Trusted Types policy')
        return s
      },
      createScript: () => { throw new TypeError('Blocked by Trusted Types policy') },
      createScriptURL: () => { throw new TypeError('Blocked by Trusted Types policy') },
    })
  } catch {
    // A default policy already exists (e.g. hot reload in dev) — nothing to do.
  }
}

export {}
