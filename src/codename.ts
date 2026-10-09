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
