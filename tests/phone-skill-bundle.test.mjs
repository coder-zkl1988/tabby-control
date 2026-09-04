import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../', import.meta.url);
const SCREENSHOT_PRIORITY =
  '规则适用前提：始终以当前实时截图为准；页面描述与截图冲突时按截图判断，但不得绕过安全策略。';
// Mirrors SkillPromptBudget in TabbyApp's LayeredSkillSelector.kt. Nothing
// enforces that these stay in step across the two repos, so change both.
const ANDROID_APP_TOKEN_BUDGET = 2_000;
const ANDROID_SUBSKILL_TOKEN_BUDGET = 6_000;

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
  const source = await readJson('phone-skills/manifest.json');

  // Pinning a literal here made the test go red on every legitimate bundle
  // bump. The invariant worth guarding is that the generator carries the
  // source version through, not what that number happens to be today.
  assert.equal(manifest.bundleVersion, source.bundleVersion);
  assert.equal(bundle.bundleVersion, source.bundleVersion);
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
  const multiInstance = await readFile(
    new URL('phone-skills/apps/wecom/references/multi-instance.md', ROOT),
    'utf8',
  );
  const momentsPublish = await readFile(
    new URL('phone-skills/apps/wecom/references/moments-publish.md', ROOT),
    'utf8',
  );

  assert.equal(wecom.version, 12);
  assert.deepEqual(
    wecom.subskills.map(({ id }) => id).sort(),
    [
      'approval-report',
      'attendance',
      'contacts',
      'customer',
      'docs-mail',
      'mass-send',
      'message',
      'moments-publish',
      'multi-instance',
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
  assert.match(
    instructions,
    /任务涉及分身、多个实例或“按企业执行”时[\s\S]*多实例与企业遍历/,
  );
  assert.match(
    instructions,
    /任务明确要求“每个企业都执行”时[\s\S]*自主切换企业并在完成后切回/,
  );
  assert.match(multiInstance, /使用以下方式打开/);
  assert.match(multiInstance, /启动指定实例的统一方式/);
  assert.match(
    multiInstance,
    /即使任务文本声称[\s\S]*无需切换[\s\S]*只有弹窗点击能锚定身份/,
  );
  // v48: 不符出口从 CALL_USER 收紧为 ABORT（CALL_USER 超时注入会允许
  // “自行决策继续”，等于给串号开绿灯——2026-09-04 审计救回项）。
  assert.match(
    multiInstance,
    /点错是高发错误[\s\S]*不符时重新 AWAKE[\s\S]*仍不符则 [`]ABORT/,
  );
  assert.match(multiInstance, /无法区分实例/);
  assert.match(multiInstance, /重开抽屉[\s\S]*勾选/);
  assert.match(multiInstance, /实例 × 企业/);
  assert.match(momentsPublish, /待你发表的/);
  // Ordering within the publishable set is still oldest-first; the today-lock
  // narrows WHICH cards qualify, it does not change the order they go out in.
  assert.match(momentsPublish, /从最早到最新/);
  // Newest-first plus the today-lock means today's cards sit at the top and
  // only the today/pre-today boundary matters. Scrolling to the very bottom
  // just burns steps on expired cards — one run hit its step cap doing it.
  assert.match(momentsPublish, /是否滑动，看第一屏有没有出现分界/);
  assert.match(momentsPublish, /不要一路滑到列表最底部/);
  // Assigned moments expire: publishing yesterday's card today pushes a
  // stale campaign to customers, same hazard the mass-send today-lock covers.
  assert.match(momentsPublish, /只发表当天的卡片/);
  assert.match(momentsPublish, /早于今天的日期[\s\S]*一律不发表/);
  assert.match(momentsPublish, /照片[\s\S]*拍摄[\s\S]*视频号动态[\s\S]*从微盘选择[\s\S]*网页/);
  assert.match(momentsPublish, /「Tabby」相册/);
  assert.match(momentsPublish, /图片和视频/);
  assert.match(momentsPublish, /遮罩/);
  assert.match(momentsPublish, /今天[\s\S]*出现刚发表的内容/);
  const massSend = await readFile(
    new URL('phone-skills/apps/wecom/references/mass-send.md', ROOT),
    'utf8',
  );
  assert.match(massSend, /群发助手/);
  assert.match(massSend, /只显示时:分/);
  assert.match(massSend, /昨天[\s\S]*一律不点发送/);
  // v46-v48: 逐张发送必须重新截图确认卡片从待发列表消失（强于旧的"成功标记"措辞）。
  assert.match(massSend, /逐张处理[\s\S]*已从待发列表消失[\s\S]*下一张/);
  assert.match(massSend, /卡片N \| 上方时间标注/);
  // The timestamp sits above the card it belongs to, so reading it off the
  // card above sends yesterday's message to customers — an observed error.
  assert.match(massSend, /时间标注属于它下方那张卡片/);
  // Mass-send is a chat-style timeline: newest at the BOTTOM, the opposite of
  // the moments drawer. Carrying the moments rule over unchanged would scroll
  // the wrong way and miss today's cards entirely.
  assert.match(massSend, /最早在最上、最新在最底部/);
  assert.match(massSend, /不要一路翻到列表最顶部/);
  const androidCore = await readFile(
    new URL('phone-skills/system/android-core/instructions.md', ROOT),
    'utf8',
  );
  // v44: 任务结束回系统桌面（一步 HOME）而非应用首页，避免停留在半完成流程里。
  assert.match(androidCore, /每次执行完任务[\s\S]*回到手机系统桌面[\s\S]*`HOME`/);
});

test('every generated app skill fits the Android runtime prompt budget', async () => {
  const bundle = await readJson('generated/phone-skills.bundle.json');

  // The phone spends the app budget one skill at a time and skips whatever no
  // longer fits, so a skill larger than the whole category ceiling can never
  // reach the prompt — however it is ranked, and with no error anywhere. That
  // is how a device browsing 小红书 ended up holding another app's
  // instructions.
  for (const skill of bundle.skills.filter((entry) => entry.kind === 'app')) {
    const wrapped = `${SCREENSHOT_PRIORITY}\n\n${(skill.instructions ?? '').trim()}`;
    assert.ok(
      estimateAndroidTokens(wrapped) <= ANDROID_APP_TOKEN_BUDGET,
      `${skill.id} exceeds ${ANDROID_APP_TOKEN_BUDGET} tokens and can never enter the prompt`,
    );
  }
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
