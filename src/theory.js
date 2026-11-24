// 乐理基础：音高、和弦、调性兼容规则。所有规则显式可查，供调度与校验共用。

const PC_BY_NAME = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5,
  'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11,
};
const PC_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

const QUALITY_INTERVALS = {
  '': [0, 4, 7],
  maj: [0, 4, 7],
  m: [0, 3, 7],
  '7': [0, 4, 7, 10],
  m7: [0, 3, 7, 10],
  maj7: [0, 4, 7, 11],
  dim: [0, 3, 6],
};
const QUALITY_ORDER = ['maj7', 'm7', 'dim', 'maj', 'm', '7', ''];

export function parseChord(name) {
  const m = /^([A-G](?:#|b)?)(.*)$/.exec(name);
  if (!m) throw new Error(`无法解析和弦: ${name}`);
  const root = PC_BY_NAME[m[1]];
  if (root === undefined) throw new Error(`无法解析和弦根音: ${name}`);
  let suffix = m[2];
  let quality = '';
  for (const q of QUALITY_ORDER) {
    if (q !== '' && suffix.startsWith(q)) { quality = q; break; }
  }
  if (suffix !== '' && quality === '' && QUALITY_INTERVALS[suffix] === undefined) {
    throw new Error(`无法解析和弦性质: ${name}`);
  }
  if (quality === '' && suffix !== '') quality = suffix;
  const intervals = QUALITY_INTERVALS[quality];
  if (!intervals) throw new Error(`未知和弦性质: ${name}`);
  return {
    name,
    root,
    quality: quality === '' ? 'maj' : quality,
    pcs: intervals.map((i) => (root + i) % 12),
  };
}

export function midiOf(noteName) {
  const m = /^([A-G](?:#|b)?)(-?\d)$/.exec(noteName);
  if (!m) throw new Error(`无法解析音名: ${noteName}`);
  const pc = PC_BY_NAME[m[1]];
  if (pc === undefined) throw new Error(`无法解析音名: ${noteName}`);
  return 12 * (Number(m[2]) + 1) + pc;
}

export function midiName(midi) {
  const pc = ((midi % 12) + 12) % 12;
  const oct = Math.floor(midi / 12) - 1;
  return `${PC_NAMES[pc]}${oct}`;
}

// 调性兼容：同调、关系大小调、同调性的纯五度/纯四度关系。
export function keysCompatible(a, b) {
  if (a.tonic === b.tonic && a.mode === b.mode) return true;
  if (a.mode !== b.mode) {
    const major = a.mode === 'major' ? a : b;
    const minor = a.mode === 'minor' ? a : b;
    if ((major.tonic - minor.tonic + 12) % 12 === 3) return true;
  }
  if (a.mode === b.mode) {
    const d = (a.tonic - b.tonic + 12) % 12;
    if (d === 5 || d === 7) return true;
  }
  return false;
}

export function fifthRelatedRoots(ca, cb) {
  const d = (ca.root - cb.root + 12) % 12;
  return d === 5 || d === 7;
}

// 和弦连接兼容：共同音 >= 2，或共同音 >= 1 且根音为五度/四度关系。
export function chordsCompatible(ca, cb) {
  const shared = ca.pcs.filter((p) => cb.pcs.includes(p)).length;
  if (shared >= 2) return true;
  if (shared >= 1 && fifthRelatedRoots(ca, cb)) return true;
  return false;
}

export function consonantWithChord(pc, chord) {
  return chord.pcs.includes(((pc % 12) + 12) % 12);
}

export function keyName(key) {
  return `${PC_NAMES[key.tonic]} ${key.mode === 'major' ? '大调' : '小调'}`;
}
