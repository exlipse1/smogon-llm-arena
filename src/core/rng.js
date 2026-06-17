export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function intSeedToShowdownSeed(seed) {
  let state = seed >>> 0;
  const out = [];
  for (let i = 0; i < 4; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out.push(state & 0xffff);
  }
  return out;
}

export function sample(array, random) {
  if (!array.length) throw new Error('Cannot sample from an empty array.');
  return array[Math.floor(random() * array.length)];
}
