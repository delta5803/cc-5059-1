// 自制曲谱：主题、过渡、收束短谱 + 条件连接图。
// 事件: e(拍位, 时值, 音名, 力度, 声部, 延音?) —— 延音表示该音在段落出口处越界延长的拍数。
import { midiOf } from './theory.js';

const e = (b, d, pitch, v, vo, tie) => {
  const ev = { b, d, p: midiOf(pitch), v, vo };
  if (tie) ev.tie = tie;
  return ev;
};
const bar = (chord, events) => ({ chord, events });

export const SCORE = {
  title: '段落引擎示例曲谱',
  start: 'theme_dawn',
  moods: {
    calm: ['theme_dawn'],
    tense: ['theme_tide'],
    heroic: ['theme_anthem'],
    drift: ['theme_drift'],
    end: ['ending_home', 'ending_fall'],
  },
  sections: {
    theme_dawn: {
      id: 'theme_dawn', title: '主题·晨', kind: 'theme', mood: 'calm',
      key: { tonic: 2, mode: 'major' }, meter: { num: 4, den: 4 }, tempo: 92,
      prepareBeats: 4,
      pickupBeats: 1,
      pickup: [e(0, 1, 'A4', 70, 'mel')],
      phrases: [
        {
          exitable: true,
          bars: [
            bar('D', [e(0, 2, 'D4', 72, 'mel'), e(2, 2, 'F#4', 70, 'mel'), e(0, 4, 'D3', 55, 'bas')]),
            bar('G', [e(0, 1, 'G4', 70, 'mel'), e(1, 1, 'A4', 70, 'mel'), e(2, 2, 'B4', 72, 'mel'), e(0, 4, 'G2', 55, 'bas')]),
            bar('Em', [e(0, 2, 'B4', 72, 'mel'), e(2, 1, 'A4', 68, 'mel'), e(3, 1, 'G4', 68, 'mel'), e(0, 4, 'E3', 55, 'bas')]),
            bar('A7', [e(0, 2, 'A4', 70, 'mel'), e(2, 2, 'C#5', 72, 'mel'), e(0, 4, 'A2', 55, 'bas')]),
          ],
          exit: {
            bars: [
              bar('D', [e(0, 1, 'E4', 70, 'mel'), e(1, 1, 'F#4', 70, 'mel'), e(2, 2, 'D4', 74, 'mel'), e(0, 4, 'D3', 55, 'bas')]),
            ],
          },
        },
        {
          exitable: true,
          bars: [
            bar('D', [e(0, 1, 'F#4', 70, 'mel'), e(1, 1, 'G4', 70, 'mel'), e(2, 2, 'A4', 72, 'mel'), e(0, 4, 'D3', 55, 'bas')]),
            bar('Bm', [e(0, 2, 'B4', 72, 'mel'), e(2, 1, 'A4', 68, 'mel'), e(3, 1, 'F#4', 68, 'mel'), e(0, 4, 'B2', 55, 'bas')]),
            bar('G', [e(0, 2, 'G4', 70, 'mel'), e(2, 2, 'E4', 68, 'mel'), e(0, 4, 'G2', 55, 'bas')]),
            bar('D', [e(0, 4, 'D4', 72, 'mel'), e(0, 4, 'D3', 55, 'bas')]),
          ],
          exit: {
            bars: [
              bar('D', [e(0, 1, 'E4', 70, 'mel'), e(1, 1, 'F#4', 70, 'mel'), e(2, 2, 'D4', 74, 'mel', 1), e(0, 4, 'D3', 55, 'bas')]),
            ],
            tail: [e(0, 2, 'D3', 45, 'bas')],
          },
        },
      ],
    },

    theme_tide: {
      id: 'theme_tide', title: '主题·潮', kind: 'theme', mood: 'tense',
      key: { tonic: 11, mode: 'minor' }, meter: { num: 4, den: 4 }, tempo: 112,
      prepareBeats: 4,
      pickupBeats: 0,
      pickup: [],
      phrases: [
        {
          exitable: true,
          bars: [
            bar('Bm', [e(0, 1, 'B4', 74, 'mel'), e(1, 1, 'A4', 72, 'mel'), e(2, 2, 'F#4', 72, 'mel'), e(0, 4, 'B2', 58, 'bas')]),
            bar('G', [e(0, 2, 'G4', 72, 'mel'), e(2, 1, 'A4', 72, 'mel'), e(3, 1, 'B4', 74, 'mel'), e(0, 4, 'G2', 58, 'bas')]),
            bar('Em', [e(0, 2, 'B4', 74, 'mel'), e(2, 2, 'G4', 72, 'mel'), e(0, 4, 'E3', 58, 'bas')]),
            bar('F#7', [e(0, 2, 'A#4', 74, 'mel'), e(2, 2, 'F#4', 72, 'mel'), e(0, 4, 'F#2', 58, 'bas')]),
          ],
          exit: {
            bars: [
              bar('Bm', [e(0, 1, 'A4', 72, 'mel'), e(1, 1, 'B4', 74, 'mel'), e(2, 2, 'F#4', 74, 'mel'), e(0, 4, 'B2', 58, 'bas')]),
            ],
          },
        },
        {
          exitable: true,
          bars: [
            bar('Bm', [e(0, 1, 'D5', 76, 'mel'), e(1, 1, 'C#5', 74, 'mel'), e(2, 2, 'B4', 74, 'mel'), e(0, 4, 'B2', 58, 'bas')]),
            bar('Em', [e(0, 2, 'G4', 72, 'mel'), e(2, 1, 'F#4', 72, 'mel'), e(3, 1, 'E4', 70, 'mel'), e(0, 4, 'E3', 58, 'bas')]),
            bar('Bm', [e(0, 2, 'F#4', 72, 'mel'), e(2, 2, 'A4', 72, 'mel'), e(0, 4, 'B2', 58, 'bas')]),
            bar('Bm', [e(0, 4, 'B4', 74, 'mel'), e(0, 4, 'B2', 58, 'bas')]),
          ],
          exit: {
            bars: [
              bar('Bm', [e(0, 1, 'A4', 72, 'mel'), e(1, 1, 'B4', 74, 'mel'), e(2, 2, 'F#4', 74, 'mel', 1), e(0, 4, 'B2', 58, 'bas')]),
            ],
            tail: [e(0, 2, 'F#3', 46, 'bas')],
          },
        },
      ],
    },

    theme_anthem: {
      id: 'theme_anthem', title: '主题·歌', kind: 'theme', mood: 'heroic',
      key: { tonic: 7, mode: 'major' }, meter: { num: 4, den: 4 }, tempo: 120,
      prepareBeats: 4,
      pickupBeats: 2,
      pickup: [e(0, 1, 'D5', 78, 'mel'), e(1, 1, 'B4', 76, 'mel')],
      phrases: [
        {
          exitable: true,
          bars: [
            bar('G', [e(0, 1, 'G4', 76, 'mel'), e(1, 1, 'B4', 76, 'mel'), e(2, 2, 'D5', 78, 'mel'), e(0, 4, 'G2', 60, 'bas')]),
            bar('C', [e(0, 2, 'E5', 78, 'mel'), e(2, 1, 'D5', 76, 'mel'), e(3, 1, 'C5', 76, 'mel'), e(0, 4, 'C3', 60, 'bas')]),
            bar('G', [e(0, 2, 'B4', 76, 'mel'), e(2, 2, 'G4', 74, 'mel'), e(0, 4, 'G2', 60, 'bas')]),
            bar('D7', [e(0, 2, 'A4', 74, 'mel'), e(2, 2, 'F#4', 74, 'mel'), e(0, 4, 'D3', 60, 'bas')]),
          ],
          exit: {
            bars: [
              bar('G', [e(0, 1, 'B4', 76, 'mel'), e(1, 1, 'D5', 78, 'mel'), e(2, 2, 'G4', 78, 'mel'), e(0, 4, 'G2', 60, 'bas')]),
            ],
          },
        },
        {
          exitable: true,
          bars: [
            bar('G', [e(0, 2, 'D5', 78, 'mel'), e(2, 2, 'B4', 76, 'mel'), e(0, 4, 'G2', 60, 'bas')]),
            bar('Em', [e(0, 2, 'G4', 74, 'mel'), e(2, 2, 'B4', 76, 'mel'), e(0, 4, 'E3', 60, 'bas')]),
            bar('C', [e(0, 2, 'C5', 76, 'mel'), e(2, 2, 'E5', 78, 'mel'), e(0, 4, 'C3', 60, 'bas')]),
            bar('G', [e(0, 4, 'G4', 76, 'mel'), e(0, 4, 'G2', 60, 'bas')]),
          ],
          exit: {
            bars: [
              bar('G', [e(0, 1, 'A4', 74, 'mel'), e(1, 1, 'B4', 76, 'mel'), e(2, 2, 'G4', 78, 'mel', 1), e(0, 4, 'G2', 60, 'bas')]),
            ],
          },
        },
      ],
    },

    theme_drift: {
      id: 'theme_drift', title: '主题·游', kind: 'theme', mood: 'drift',
      key: { tonic: 3, mode: 'major' }, meter: { num: 4, den: 4 }, tempo: 100,
      prepareBeats: 4,
      pickupBeats: 0,
      pickup: [],
      phrases: [
        {
          exitable: true,
          bars: [
            bar('Eb', [e(0, 1, 'Eb4', 70, 'mel'), e(1, 1, 'G4', 70, 'mel'), e(2, 2, 'Bb4', 72, 'mel'), e(0, 4, 'Eb3', 55, 'bas')]),
            bar('Bb', [e(0, 2, 'Bb4', 72, 'mel'), e(2, 2, 'F4', 70, 'mel'), e(0, 4, 'Bb2', 55, 'bas')]),
            bar('Cm', [e(0, 2, 'G4', 70, 'mel'), e(2, 2, 'C5', 72, 'mel'), e(0, 4, 'C3', 55, 'bas')]),
            bar('Eb', [e(0, 4, 'Eb4', 70, 'mel'), e(0, 4, 'Eb3', 55, 'bas')]),
          ],
        },
      ],
    },

    tr_ember: {
      id: 'tr_ember', title: '过渡·烬 (Bm→G)', kind: 'transition',
      key: { tonic: 11, mode: 'minor' }, toKey: { tonic: 7, mode: 'major' },
      meter: { num: 4, den: 4 }, tempo: 116,
      prepareBeats: 0, pickupBeats: 0, pickup: [],
      phrases: [
        {
          exitable: false,
          bars: [
            bar('Bm', [e(0, 1, 'F#4', 72, 'mel'), e(1, 1, 'A4', 72, 'mel'), e(2, 2, 'B4', 74, 'mel'), e(0, 4, 'B2', 56, 'bas')]),
            bar('D7', [e(0, 2, 'A4', 74, 'mel'), e(2, 2, 'C5', 74, 'mel'), e(0, 4, 'D3', 56, 'bas')]),
          ],
        },
      ],
    },

    tr_dusk: {
      id: 'tr_dusk', title: '过渡·暮 (G→Bm)', kind: 'transition',
      key: { tonic: 7, mode: 'major' }, toKey: { tonic: 11, mode: 'minor' },
      meter: { num: 4, den: 4 }, tempo: 116,
      prepareBeats: 0, pickupBeats: 0, pickup: [],
      phrases: [
        {
          exitable: false,
          bars: [
            bar('Em', [e(0, 2, 'G4', 72, 'mel'), e(2, 2, 'B4', 74, 'mel'), e(0, 4, 'E3', 56, 'bas')]),
            bar('Bm', [e(0, 1, 'A4', 72, 'mel'), e(1, 1, 'F#4', 72, 'mel'), e(2, 2, 'B4', 74, 'mel'), e(0, 4, 'B2', 56, 'bas')]),
          ],
        },
      ],
    },

    ending_home: {
      id: 'ending_home', title: '收束·归', kind: 'ending', mood: 'end',
      key: { tonic: 2, mode: 'major' }, meter: { num: 4, den: 4 }, tempo: 88,
      prepareBeats: 0, pickupBeats: 0, pickup: [],
      phrases: [
        {
          exitable: false,
          bars: [
            bar('G', [e(0, 2, 'B4', 72, 'mel'), e(2, 2, 'D5', 74, 'mel'), e(0, 4, 'G2', 54, 'bas')]),
            bar('A7', [e(0, 2, 'C#5', 74, 'mel'), e(2, 2, 'A4', 72, 'mel'), e(0, 4, 'A2', 54, 'bas')]),
            bar('D', [e(0, 4, 'D5', 76, 'mel'), e(0, 4, 'D3', 56, 'bas')]),
          ],
          tail: [e(0, 4, 'D3', 42, 'bas'), e(0, 4, 'D4', 42, 'mel')],
        },
      ],
    },

    ending_fall: {
      id: 'ending_fall', title: '收束·落', kind: 'ending', mood: 'end',
      key: { tonic: 11, mode: 'minor' }, meter: { num: 4, den: 4 }, tempo: 88,
      prepareBeats: 0, pickupBeats: 0, pickup: [],
      phrases: [
        {
          exitable: false,
          bars: [
            bar('Em', [e(0, 2, 'G4', 72, 'mel'), e(2, 2, 'B4', 74, 'mel'), e(0, 4, 'E3', 54, 'bas')]),
            bar('F#7', [e(0, 2, 'A#4', 74, 'mel'), e(2, 2, 'F#4', 72, 'mel'), e(0, 4, 'F#2', 54, 'bas')]),
            bar('Bm', [e(0, 4, 'B4', 76, 'mel'), e(0, 4, 'B2', 56, 'bas')]),
          ],
          tail: [e(0, 4, 'B2', 42, 'bas')],
        },
      ],
    },
  },

  // 条件连接图：只有声明的边才允许连接；直接边还需通过调性检查，via 边经过过渡段。
  links: [
    { from: 'theme_dawn', to: 'theme_tide' },
    { from: 'theme_tide', to: 'theme_dawn' },
    { from: 'theme_dawn', to: 'theme_anthem' },
    { from: 'theme_anthem', to: 'theme_dawn' },
    { from: 'theme_tide', to: 'theme_anthem', via: 'tr_ember' },
    { from: 'theme_anthem', to: 'theme_tide', via: 'tr_dusk' },
    { from: 'theme_dawn', to: 'ending_home' },
    { from: 'theme_anthem', to: 'ending_home' },
    { from: 'theme_tide', to: 'ending_fall' },
  ],
};

export function barLen(sec) {
  return sec.meter.num * (4 / sec.meter.den);
}

export function phraseLen(sec, phrase) {
  return phrase.bars.length * barLen(sec);
}

export function loopLen(sec) {
  return sec.phrases.reduce((sum, ph) => sum + phraseLen(sec, ph), 0);
}
