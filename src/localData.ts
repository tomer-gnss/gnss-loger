// Everything this site keeps on the device lives under the `atlas.` prefix in localStorage /
// sessionStorage: consents, the public-orbit cache, dismissed hints. Never a position.

const WELCOME_KEY = 'atlas.welcomeSeen'
export const welcomeSeen = () => { try { return localStorage.getItem(WELCOME_KEY) === '1' } catch { return false } }
export const markWelcomeSeen = () => { try { localStorage.setItem(WELCOME_KEY, '1') } catch { /* storage blocked */ } }

/** Remove everything the site stored on this device. */
export function eraseLocalData() {
  for (const get of [() => localStorage, () => sessionStorage]) {
    try {
      const store = get()
      for (const k of Object.keys(store)) if (k.startsWith('atlas.')) store.removeItem(k)
    } catch { /* storage blocked: nothing was stored either */ }
  }
}
