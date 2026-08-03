import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../', import.meta.url);
const SCREENSHOT_PRIORITY =
  '规则适用前提：始终以当前实时截图为准；页面描述与截图冲突时按截图判断，但不得绕过安全策略。';
const ANDROID_SUBSKILL_TOKEN_BUDGET = 2_200;

function estimateAndroidTokens(text) {
  return Math.max(1, Math.ceil([...text].length / 2));
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, ROOT), 'utf8'));
}

test('generated phone skill bundle contains all three layers', async () => {
  const manifest = await readJson('generated/phone-skills.manifest.json');
  const bundle = await readJson('generated/phone-skills.bundle.json');
  const skills = manifest.skills;

  assert.equal(manifest.bundleVersion, 16);
  assert.deepEqual(
    [...new Set(skills.map((skill) => skill.kind))].sort(),
    ['app', 'oem', 'system'],
  );
  assert.equal(new Set(skills.map((skill) => skill.id)).size, skills.length);
  assert.match(manifest.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    skills.map(({ id, kind, version, targetPackages }) => ({
      id,
      kind,
      version,
      targetPackages,
    })),
    bundle.skills.map(({ id, kind, version, targetPackages }) => ({
      id,
      kind,
      version,
      targetPackages,
    })),
  );
});

test('system and OEM sources activate by capability instead of target app package', async () => {
  const systemSkill = await readJson('phone-skills/system/app-install/skill.json');
  const oemSkill = await readJson('phone-skills/oem/xiaomi-hyperos/skill.json');

  assert.equal(systemSkill.kind, 'system');
  assert.deepEqual(systemSkill.targetPackages, []);
  assert.ok(systemSkill.capabilities.includes('app.install.official_store'));
  assert.ok(systemSkill.activation.intents.includes('app.install'));

  assert.equal(oemSkill.kind, 'oem');
  assert.deepEqual(oemSkill.targetPackages, []);
  assert.ok(
    oemSkill.activation.manufacturers.some(
      (manufacturer) => manufacturer.toLowerCase() === 'xiaomi',
    ),
  );
});

test('XHS declares system capability dependencies without embedding OEM install rules', async () => {
  const xhs = await readJson('phone-skills/apps/xhs/skill.json');
  const instructions = await readFile(
    new URL('phone-skills/apps/xhs/instructions.md', ROOT),
    'utf8',
  );
  const login = await readFile(
    new URL('phone-skills/apps/xhs/references/login.md', ROOT),
    'utf8',
  );
  const browse = await readFile(
    new URL('phone-skills/apps/xhs/references/browse.md', ROOT),
    'utf8',
  );
  const loginSubskill = xhs.subskills.find((item) => item.id === 'login');
  const postSubskill = xhs.subskills.find((item) => item.id === 'post');
  const competingPriorities = xhs.subskills
    .filter((item) => item.id !== 'post')
    .map((item) => item.priority);

  assert.equal(xhs.kind, 'app');
  assert.ok(loginSubskill.requiresCapabilities.includes('app.install.official_store'));
  assert.ok(loginSubskill.requiresCapabilities.includes('sms.verification'));
  assert.ok(
    postSubskill.priority > Math.max(...competingPriorities),
    'publish instructions must be loaded before lower-priority XHS subskills exhaust the phone prompt budget',
  );
  assert.doesNotMatch(instructions, /com\.xiaomi\.market|应用宝|浏览器下载 APK/i);
  assert.doesNotMatch(login, /com\.xiaomi\.market|应用宝|浏览器下载 APK/i);
  assert.match(instructions, /顶部“发现”被选中.*已经位于底部首页/s);
  assert.match(instructions, /不要重复点击“首页”/);
  assert.match(browse, /底部导航即使隐约可见也可能只是下层页面/);
  assert.match(browse, /只要求“打开\/确认首页”.*立即 `COMPLETE`/s);
});

test('Douyin v2 captures verified navigation and high-risk operation boundaries', async () => {
  const douyin = await readJson('phone-skills/apps/douyin/skill.json');
  const instructions = await readFile(
    new URL('phone-skills/apps/douyin/instructions.md', ROOT),
    'utf8',
  );
  const search = await readFile(
    new URL('phone-skills/apps/douyin/references/search.md', ROOT),
    'utf8',
  );
  const publish = await readFile(
    new URL('phone-skills/apps/douyin/references/publish.md', ROOT),
    'utf8',
  );

  assert.equal(douyin.version, 2);
  assert.deepEqual(
    douyin.subskills.map(({ id }) => id).sort(),
    ['browse', 'commerce', 'interact', 'live', 'message', 'profile', 'publish', 'search'],
  );
  assert.match(instructions, /点赞、评论、收藏、分享通常在\*\*右侧竖排\*\*/);
  assert.match(instructions, /默认只读/);
  assert.match(search, /综合[\s\S]*商品[\s\S]*用户[\s\S]*店铺[\s\S]*视频[\s\S]*图文/);
  assert.match(publish, /分段拍 \/ 照片 \/ 视频/);
  assert.match(publish, /最终“发布”按钮前[\s\S]*确认/);
});

test('WeCom v1 covers verified work modules and commit boundaries', async () => {
  const wecom = await readJson('phone-skills/apps/wecom/skill.json');
  const instructions = await readFile(
    new URL('phone-skills/apps/wecom/instructions.md', ROOT),
    'utf8',
  );
  const approvalReport = await readFile(
    new URL('phone-skills/apps/wecom/references/approval-report.md', ROOT),
    'utf8',
  );
  const scheduleMeeting = await readFile(
    new URL('phone-skills/apps/wecom/references/schedule-meeting.md', ROOT),
    'utf8',
  );

  assert.equal(wecom.version, 1);
  assert.deepEqual(
    wecom.subskills.map(({ id }) => id).sort(),
    [
      'approval-report',
      'attendance',
      'contacts',
      'customer',
      'docs-mail',
      'message',
      'schedule-meeting',
      'search',
      'workbench-account',
    ],
  );
  assert.match(instructions, /消息 \/ 邮件 \/ 文档 \/ 工作台 \/ 通讯录/);
  assert.match(instructions, /默认只读/);
  assert.match(instructions, /发送 \/ 保存 \/ 提交 \/ 打卡 \/ 确认添加 \/ 发起会议/);
  assert.match(approvalReport, /假勤[\s\S]*财务[\s\S]*行政[\s\S]*人事/);
  assert.match(scheduleMeeting, /智能纪要[\s\S]*知情/);
});

test('every generated subskill fits the Android runtime prompt budget', async () => {
  const bundle = await readJson('generated/phone-skills.bundle.json');
  for (const skill of bundle.skills) {
    for (const subskill of skill.subskills ?? []) {
      const wrapped = `${SCREENSHOT_PRIORITY}\n\n${subskill.content.trim()}`;
      assert.ok(
        estimateAndroidTokens(wrapped) <= ANDROID_SUBSKILL_TOKEN_BUDGET,
        `${skill.id}/${subskill.id} exceeds ${ANDROID_SUBSKILL_TOKEN_BUDGET} tokens`,
      );
    }
  }
});
