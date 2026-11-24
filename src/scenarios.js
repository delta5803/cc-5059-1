// 内置示例情境：覆盖正常换乘、抢占、延后入队、过晚顺延、不可达异常、收束。
export const DEMO_SCENARIO = {
  start: 'theme_dawn',
  until: 164,
  note: '示例：6 正常换乘；20→24 抢占；36 计划后 46 被锁定入队；78 过晚顺延到下一出口；100 经过渡段；126 不可达异常；130 收束；134 收束锁定后入队',
  requests: [
    { t: 6, mood: 'tense' },
    { t: 20, mood: 'heroic' },
    { t: 24, mood: 'calm' },
    { t: 36, mood: 'heroic' },
    { t: 46, mood: 'calm' },
    { t: 78, mood: 'tense' },
    { t: 100, mood: 'heroic' },
    { t: 126, mood: 'drift' },
    { t: 130, mood: 'end' },
    { t: 134, mood: 'calm' },
  ],
};
