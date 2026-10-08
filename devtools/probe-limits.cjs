// ============================================================
//  devtools/probe-limits.cjs —— 对账探针：**面板显示的值 vs 机器人实际读到的值**
//
//  🔴 为什么必须这么验（本项目铁律）：
//    "配置类失效天生静默"—— 面板显示 3000、机器人却在用 1600，这种 bug 不会报错。
//    所以唯一可信的验证是**对账**：让两个进程各自用**自己的环境**读一次，看数字对不对得上。
//    （踩过：用面板的 APP_DIR 去验机器人的事，bug 躲过好几轮验证。）
//
//  跑法（在服务器上，用机器人自己的环境）：
//    cd /opt/xiaolanjing && APP_DIR=/opt/xiaolanjing node /tmp/probe-limits.cjs
//    cd /opt/xiaolanjing && APP_DIR=/opt/xiaolanjing node /tmp/probe-limits.cjs dailyCalls=3100
//      ↑ 带参数 = 调 settings.update() 真的改一次（**会自动写文件**），用来验"写得进去"
//
//  输出：JSON，含"设定值 / 机器人读到的值 / 面板会显示的值 / 是否一致"
// ============================================================
const path = require('path');
const settings = require('./settings');
const budget = require('./budget');
const cfg = require('./config');

const out = {
  cwd: process.cwd(),
  APP_DIR_ENV: process.env.APP_DIR || '(未设置)',
  settings_FILE: settings.FILE,
  config_default_dailyCallLimit: cfg.policy.dailyCallLimit,
  config_default_dailyYuan: cfg.budget && cfg.budget.dailyLimitYuan,
  config_default_totalYuan: cfg.budget && cfg.budget.totalLimitYuan,
};

// ① 机器人侧读到的（走和机器人完全同一条取值路径）
out.botReads = {
  dailyCalls: settings.num('dailyCalls', cfg.policy.dailyCallLimit),
  budgetDaily: settings.num('budgetDaily', null),
  budgetTotal: settings.num('budgetTotal', null),
};

// ② 面板会拿到的（⚠️ /api/state 走的是 persistedStatus()，**不是** status() ——
//    前者只读落盘文件，正因为如此它才能显示"机器人那边看到的数"；这里两个都取，便于对照）
const snapBot = budget.status();            // 机器人进程内的（含官方余额等实时项）
const snapPanel = budget.persistedStatus(); // 面板走的那条
out.panelShows = {
  dailyCallLimit: snapPanel.dailyCallLimit,
  dailyLimit: snapPanel.dailyLimit,
  totalLimit: snapPanel.totalLimit,
  dayCalls: snapPanel.dayCalls,
  daySpent: snapPanel.daySpent,
  spentYuan: snapPanel.spentYuan,
};
out.botLive = {
  dailyCallLimit: snapBot.dailyCallLimit,
  dailyLimit: snapBot.dailyLimit,
  dayCalls: snapBot.dayCalls,
  daySpent: snapBot.daySpent,
};

// ③ 对账：两边必须**完全相等**，否则就是"配置没传过去"
out.reconcile = {
  dailyCalls: out.botReads.dailyCalls === out.panelShows.dailyCallLimit,
  dailyYuan: Number(out.botReads.budgetDaily) === Number(out.panelShows.dailyLimit),
};

// ④ 可选：真改一次（验"写得进去 + 立刻读到"）
const arg = process.argv[2];
if (arg) {
  const m = /^([A-Za-z]+)=(.+)$/.exec(arg);
  if (m) {
    out.update = settings.update({ [m[1]]: m[2] });
    const after = budget.persistedStatus();
    out.afterUpdate = { dailyCallLimit: after.dailyCallLimit, dailyLimit: after.dailyLimit };
    out.afterSettingsFile = require('fs').readFileSync(settings.FILE, 'utf8');
  }
}

console.log(JSON.stringify(out, null, 1));
