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

// 边界条件：第二条请求在第 16 拍乐句的首个弱起音已排队（第 8 拍排队）、
// 但尚未发声（首个弱起音第 14 拍）时到达。
//  - legacy：拼接已提交语义下延后，第 16 拍进入歌，再经暮进入潮（下一乐句接管）；
//  - immediate：立即取消未发声拼接，本边界第 16 拍改去潮。
export const BOUNDARY_SCENARIO = {
  start: 'theme_dawn',
  until: 64,
  note: '边界：6 请求歌；12.5 在首个弱起音发声前改请求潮',
  requests: [
    { t: 6, mood: 'heroic' },
    { t: 12.5, mood: 'tense' },
  ],
};
