export const DUCKS = [
  'MALLARD', 'TEAL', 'EIDER', 'PINTAIL', 'GOLDENEYE', 'WIGEON', 'SCAUP', 'MERGANSER',
  'BUFFLEHEAD', 'CANVASBACK', 'GADWALL', 'SHOVELER', 'REDHEAD', 'HARLEQUIN', 'SMEW', 'GARGANEY',
] as const

export function fnv1a(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

const SUFFIXES = 36 * 36

function suffix(n: number): string {
  return n.toString(36).toUpperCase().padStart(2, '0')
}

export function codenameFor(id: string, taken: ReadonlySet<string>): string {
  const h = fnv1a(id)
  const name = DUCKS[h % DUCKS.length]!
  let n = (h >>> 16) % SUFFIXES
  for (let tries = 0; tries < SUFFIXES; tries++) {
    const candidate = `${name}-${suffix(n)}`
    if (!taken.has(candidate)) return candidate
    n = (n + 1) % SUFFIXES
  }
  // every suffix for this duck is taken: a collision is better than no codename
  return `${name}-${suffix(n)}`
}
