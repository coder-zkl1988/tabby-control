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

  assert.equal(manifest.bundleVersion, 13);
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

  assert.equal(xhs.kind, 'app');
  assert.ok(loginSubskill.requiresCapabilities.includes('app.install.official_store'));
  assert.ok(loginSubskill.requiresCapabilities.includes('sms.verification'));
  assert.doesNotMatch(instructions, /com\.xiaomi\.market|应用宝|浏览器下载 APK/i);
  assert.doesNotMatch(login, /com\.xiaomi\.market|应用宝|浏览器下载 APK/i);
  assert.match(instructions, /顶部“发现”被选中.*已经位于底部首页/s);
  assert.match(instructions, /不要重复点击“首页”/);
  assert.match(browse, /底部导航即使隐约可见也可能只是下层页面/);
  assert.match(browse, /只要求“打开\/确认首页”.*立即 `COMPLETE`/s);
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
