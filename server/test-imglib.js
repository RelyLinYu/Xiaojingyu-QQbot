// 一次性（**临时**）：图库模块的本地自测（写本地临时目录、不碰真实数据、不调模型）
process.env.XLJ_NO_PERSIST = '1';                 // 只动内存，不落盘
process.env.APP_DIR = require('path').join(require('os').tmpdir(), 'imglib-test');

const imglib = require('./imglib');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

// 造几张最小合法图片字节
function pngBytes() {
  // 1×1 透明 PNG
  return Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001'
    + '0d0a2db40000000049454e44ae426082', 'hex');
}
function jpegBytes() { return Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(64, 7), Buffer.from([0xFF, 0xD9])]); }
function webpBytes() { return Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 0), Buffer.from('WEBP'), Buffer.alloc(16, 1)]); }
function gifBytes() { return Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(20, 2)]); }

(async () => {
  console.log('=== 1. 格式判别（按字节，不看文件名）===');
  ok('PNG 认得出', imglib.sniff(pngBytes()) === 'image/png');
  ok('JPEG 认得出', imglib.sniff(jpegBytes()) === 'image/jpeg');
  ok('WEBP 认得出', imglib.sniff(webpBytes()) === 'image/webp');
  ok('GIF 认得出', imglib.sniff(gifBytes()) === 'image/gif');
  ok('随便一段字节认不出（会被拒）', imglib.sniff(Buffer.from('hello world hello world')) === '');

  console.log('\n=== 2. 加图（AI 描述会失败，但要照样存下来）===');
  const buf1 = pngBytes();
  const r1 = await imglib.add(buf1, { name: '测试图1' }, (m) => console.log('      · ' + m));
  ok('加图成功', r1.ok === true, JSON.stringify(r1));
  ok('状态是 pending（等确认）', r1.item && r1.item.status === 'pending');
  ok('字节数记下来了', r1.item && r1.item.bytes === buf1.length);
  ok('有 md5（用于去重）', r1.item && typeof r1.item.hash === 'string' && r1.item.hash.length > 0);
  ok('AI 描述为空时也不报错（留空让用户自己补）', r1.item && r1.item.desc === '');

  console.log('\n=== 3. md5 去重 ===');
  const r2 = await imglib.add(pngBytes(), {}, () => {});
  ok('同一张图再传 → 不新增，直接回已存在那张', r2.ok === true && r2.dup === true && r2.item.id === r1.item.id,
    JSON.stringify(r2.ok && { dup: r2.dup }));
  ok('图库里仍然只有 1 张', imglib.list().length === 1, String(imglib.list().length));

  console.log('\n=== 4. 非图片被拒 ===');
  const rb = await imglib.add(Buffer.from('这不是图片，只是文本'), {}, () => {});
  ok('文本被拒且给了人话原因', rb.ok === false && /不是可识别的图片/.test(rb.why), JSON.stringify(rb));
  const re = await imglib.add(Buffer.alloc(0), {}, () => {});
  ok('空文件被拒', re.ok === false);

  console.log('\n=== 5. 确认 / 弃用 / 改描述 / 删除 ===');
  ok('确认后进 approved', imglib.setStatus(r1.item.id, 'approved').ok && imglib.approved().length === 1);
  ok('弃用后不进 approved', imglib.setStatus(r1.item.id, 'rejected').ok && imglib.approved().length === 0);
  imglib.setStatus(r1.item.id, 'approved');
  ok('改描述生效', imglib.update(r1.item.id, { desc: '一只在敲键盘的鲸鱼，摸鱼时发' }).ok
    && imglib.get(r1.item.id).desc.includes('摸鱼'));
  const r3 = await imglib.add(jpegBytes(), { name: '测试图2' }, () => {});
  imglib.setStatus(r3.item.id, 'approved');
  ok('第二次加图也能进库（两张）', imglib.approved().length === 2, String(imglib.approved().length));
  ok('删除一张', imglib.remove(r3.item.id).ok && imglib.list().length === 1);
  ok('删不存在的 → 给人话原因', imglib.remove('nope').ok === false);

  console.log('\n=== 6. 使用统计与关键词兜底 ===');
  imglib.markUsed(r1.item.id);
  imglib.markUsed(r1.item.id);
  ok('用过几次记下来了', imglib.get(r1.item.id).used === 2, String(imglib.get(r1.item.id).used));
  ok('关键词粗筛能命中（描述里有"摸鱼"）', imglib.matchByKeyword('今天好想摸鱼啊').length >= 1);
  ok('无关的话不命中', imglib.matchByKeyword('公式推导注意边界条件').length === 0);

  console.log('\n=== 7. 状态汇总 ===');
  const st = imglib.status();
  ok('汇总里能看到图库目录（在 data/img-lib）', /img-lib$/.test(st.dir), st.dir);
  ok('汇总数字自洽', st.total === 1 && st.approved === 1 && st.usedTotal === 2, JSON.stringify(st));

  console.log('\n=== 8. 冷却记账 & 主人豁免（2026-10-16 用户：「主人发图不该占用群友冷却」）===');
  imglib._resetSent();
  const gA = imglib.sendGate({ scope: 'S1', isOwner: true, explicit: true });
  ok('主人：闸门放行、且结果里带 ownerFree 标记', gA.ok === true && gA.ownerFree === true, JSON.stringify(gA));
  imglib.noteSent('S1', { ownerFree: gA.ownerFree });
  ok('主人发完 → **不占**群冷却（lastSent 仍是 0）', imglib.lastSent('S1') === 0, String(imglib.lastSent('S1')));
  const gB = imglib.sendGate({ scope: 'S1', isOwner: false, explicit: true });
  ok('紧跟着群友要图 → 没被主人那次挡住', gB.ok === true, JSON.stringify(gB));
  imglib.noteSent('S1', { ownerFree: gB.ownerFree });
  ok('群友发完 → 冷却记上了', imglib.lastSent('S1') > 0);
  const gC = imglib.sendGate({ scope: 'S1', isOwner: false, explicit: true });
  ok('接着另一个群友要图 → 被冷却拦住、给剩余秒数', gC.ok === false && gC.waitSec > 0, JSON.stringify(gC));
  const gD = imglib.sendGate({ scope: 'S1', isOwner: true, explicit: true });
  ok('主人不受冷却限制', gD.ok === true, JSON.stringify(gD));
  // 接线检查（调用点原文，别搜会出现在注释里的短词）：index.js 的记账点必须把 ownerFree 传下去
  const idxTxt = require('fs').readFileSync(require('path').join(__dirname, 'index.js'), 'utf8');
  ok('index.js 记账点带上了 ownerFree（调用点原文）',
    /lib\.noteSent\(scope, \{ ownerFree: gate\.ownerFree \}\)/.test(idxTxt));
  imglib._resetSent();

  console.log(`\n结果：${pass} 通过 / ${fail} 失败（共 ${pass + fail}）`);
  process.exit(fail ? 1 : 0);
})();
