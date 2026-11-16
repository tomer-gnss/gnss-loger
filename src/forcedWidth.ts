import { createContext } from 'react'

/**
 * When set, every chart inside renders at this width instead of measuring its container.
 * The report uses it while printing / saving, so charts fill an A4 page even when the
 * report was opened on a phone.
 */
export const ForcedWidth = createContext<number | null>(null)
