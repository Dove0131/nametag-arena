export const ROLE_DEFS = {
  admin:        { name: '管理员', short: '管', icon: '🛠️', desc: '掌控全局，拥有全部管理权限' },
  player:       { name: '玩家',   short: '玩', icon: '🏷️', desc: '撕掉对手的名牌，活到最后' },
  photographer: { name: '摄影',   short: '摄', icon: '📷', desc: '战场记录者，能看到所有人位置' },
  special:      { name: '特殊人物', short: '特', icon: '✨', desc: '拥有一项特殊技能，每局一次' },
};

export const CARD_DEFS = {
  revive: {
    name: '复活卡', icon: '💫', tone: 'gold',
    desc: '复活一名被淘汰的玩家。你们从此共用一条命：一人被撕，两人一起淘汰；被复活者不能撕你。',
    use: 'target-dead',
  },
  shield: {
    name: '护盾卡', icon: '🛡️', tone: 'blue',
    desc: '被动生效：抵挡一次被撕，自动消耗。无需手动使用。',
    use: 'passive',
  },
  ghost: {
    name: '隐身卡', icon: '👻', tone: 'purple',
    desc: '5 分钟内从别人的地图上消失。最后 15 分钟或管理员强制显形时无效。',
    use: 'self',
  },
  eye: {
    name: '天眼卡', icon: '👁️', tone: 'cyan',
    desc: '2 分钟内看到所有存活玩家的实时位置。',
    use: 'self',
  },
  track: {
    name: '追踪卡', icon: '🎯', tone: 'orange',
    desc: '指定一名玩家，5 分钟内持续看到 TA 的位置。',
    use: 'target-alive',
  },
  golden: {
    name: '金钟罩', icon: '🥇', tone: 'gold',
    desc: '3 分钟内免疫被撕，期间别人撕你会被系统挡住；到期自动失效。',
    use: 'self',
  },
  curse: {
    name: '曝光卡', icon: '🔮', tone: 'orange',
    desc: '指定一名存活玩家，让 TA 的位置暴露 3 分钟。',
    use: 'target-alive',
  },
  steal: {
    name: '顺手牵羊', icon: '🪝', tone: 'purple',
    desc: '指定一名存活玩家，随机偷走 TA 一张未使用的技能卡；对方没有卡时不能使用。',
    use: 'target-alive',
  },
};

export const CARD_WEIGHTS = {
  revive: 1, shield: 3, ghost: 2, eye: 2, track: 3,
  golden: 2, curse: 2, steal: 2,
};

export const EVENT_DEFS = {
  english: {
    name: '英语挑战', icon: '💬', minutes: 12, weight: 3, witness: true,
    desc: '找一位同学完成至少 5 句英文对话，让 TA 在「见证」里输入下面的见证码。',
    short: '5 句英文对话',
  },
  pushups: {
    name: '体能挑战', icon: '💪', minutes: 10, weight: 3, witness: true,
    desc: '立刻做 5 个俯卧撑，让一位同学见证并输入你的见证码。',
    short: '5 个俯卧撑',
  },
  expose: {
    name: '自曝位置', icon: '📍', minutes: 5, weight: 2, auto: 'expose',
    desc: '立刻暴露自己的位置 5 分钟。挺住！',
    short: '暴露位置 5 分钟',
  },
  find: {
    name: '寻人任务', icon: '🔍', minutes: 8, weight: 3, needsTarget: true, auto: 'find',
    desc: '在倒计时结束前找到 {target}，两人相距 30 米内自动完成。',
    short: '找到 {target}',
  },
  team: {
    name: '组队任务', icon: '🤝', minutes: 10, weight: 2, needsTarget: true, auto: 'team',
    desc: '找到 {target} 并组队 5 分钟。靠近 30 米内自动开始计时。',
    short: '和 {target} 组队 5 分钟',
  },
  ripwin: {
    name: '猎杀时刻', icon: '🗡️', minutes: 15, weight: 0.35, needsTarget: true, auto: 'ripwin',
    desc: '在 15 分钟内撕掉 {target}，你将直接获得胜利！目标不知道这件事。',
    short: '撕掉 {target} 直接获胜',
  },
  dance: {
    name: '才艺挑战', icon: '🎤', minutes: 10, weight: 2, witness: true,
    desc: '当众唱出一首歌的副歌，让一位同学见证并输入你的见证码。',
    short: '唱一首歌的副歌',
  },
  sprint: {
    name: '冲刺挑战', icon: '🏃', minutes: 5, weight: 2, auto: 'sprint',
    desc: '5 分钟内移动到距任务开始时 150 米以外，GPS 自动判定。',
    short: '5 分钟内移动 150 米',
  },
  custom: {
    name: '自定义任务', icon: '📝', minutes: 10, weight: 0,
    desc: '管理员发布的任务，按管理员要求完成。',
    short: '管理员自定义任务',
  },
};

export const SPECIAL_SKILL_DEFS = {
  shadow: {
    name: '潜行', icon: '🌫️', target: 'self',
    desc: '3 分钟内从别人的地图上消失。最后 15 分钟或管理员强制显形时无效。',
    cooldownMs: 3 * 60 * 1000,
  },
  scan: {
    name: '扫描', icon: '📡', target: 'self',
    desc: '90 秒内看到所有存活玩家的实时位置。',
    cooldownMs: 3 * 60 * 1000,
  },
  bind: {
    name: '定身', icon: '⛓️', target: 'alive',
    desc: '指定一名玩家，2 分钟内不能撕名牌、不能使用技能卡。',
    cooldownMs: 3 * 60 * 1000,
  },
  steal: {
    name: '顺手牵羊', icon: '🪝', target: 'alive',
    desc: '从目标手中随机偷走一张未使用的技能卡。',
    cooldownMs: 3 * 60 * 1000,
  },
  lucky: {
    name: '幸运', icon: '🍀', target: 'self',
    desc: '立刻随机获得一张技能卡。',
    cooldownMs: 3 * 60 * 1000,
  },
  pulse: {
    name: '震爆', icon: '💥', target: 'alive',
    desc: '指定一名玩家，暴露 TA 的位置 3 分钟。',
    cooldownMs: 3 * 60 * 1000,
  },
};

export const PLAYER_COLORS = [
  '#c8ff3d', '#ff6b35', '#4cc9f0', '#ffd166', '#b388ff',
  '#ff5d8f', '#2ec4b6', '#f7a072', '#8ecae6', '#e0aaff',
  '#a3e635', '#fb7185', '#38bdf8', '#facc15', '#34d399',
  '#f472b6', '#f97316', '#22d3ee', '#a78bfa', '#fde047',
];

export const LIMITS = {
  maxPlayers: 40,
  maxRooms: 300,
  nameMax: 12,
  chatMax: 140,
  chatHistory: 120,
  feedHistory: 100,
  roomTtlMs: 12 * 60 * 60 * 1000,
  endedRoomTtlMs: 8 * 60 * 60 * 1000,
};

export const DEFAULT_SETTINGS = {
  durationMin: 45,
  prepMin: 10,
  autoEvents: true,
  eventMinMin: 6,
  eventMaxMin: 12,
  ripRange: 30,
  locked: false,
  specialCount: 1,
};

export const WIN_LABEL = {
  good: '幸存者胜利',
  player: '个人胜利',
  draw: '平局',
};
