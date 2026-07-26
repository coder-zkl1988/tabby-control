#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
const SOURCE_DIR = path.join(ROOT, 'phone-skills');
const GENERATED_DIR = path.join(ROOT, 'generated');
const BUNDLE_PATH = path.join(GENERATED_DIR, 'phone-skills.bundle.json');
const GENERATED_MANIFEST_PATH = path.join(GENERATED_DIR, 'phone-skills.manifest.json');
const args = process.argv.slice(2);
const SKILL_KINDS = new Set(['system', 'oem', 'app']);
const SKILL_DIR_PREFIX = {
  system: 'system/',
  oem: 'oem/',
  app: 'apps/',
};

function fail(message) {
  throw new Error(`[phone-skills] ${message}`);
}

function getArgValue(name) {
  const exactIndex = args.indexOf(name);
  if (exactIndex >= 0) return args[exactIndex + 1];
  const prefix = `${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function assertString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${field} 必须是非空字符串`);
  }
}

function assertInteger(value, field, minimum = Number.MIN_SAFE_INTEGER) {
  if (!Number.isInteger(value) || value < minimum) {
    fail(`${field} 必须是不小于 ${minimum} 的整数`);
  }
}

function assertSafeRelativePath(value, field) {
  assertString(value, field);
  if (
    path.isAbsolute(value) ||
    value.includes('\\') ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    fail(`${field} 不是安全的相对路径: ${value}`);
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    fail(`无法读取 JSON ${path.relative(ROOT, filePath)}: ${String(error)}`);
  }
}

function validateExamples(examples, skillId) {
  if (examples == null) return [];
  if (!Array.isArray(examples)) fail(`${skillId}.examples 必须是数组`);
  return examples.map((example, exampleIndex) => {
    assertString(example?.scenario, `${skillId}.examples[${exampleIndex}].scenario`);
    if (!Array.isArray(example.steps) || example.steps.length === 0) {
      fail(`${skillId}.examples[${exampleIndex}].steps 必须是非空数组`);
    }
    const steps = example.steps.map((step, stepIndex) => {
      if (typeof step?.observe !== 'string' || typeof step?.action !== 'string') {
        fail(`${skillId}.examples[${exampleIndex}].steps[${stepIndex}] 字段无效`);
      }
      return { observe: step.observe, action: step.action };
    });
    return { scenario: example.scenario, steps };
  });
}

function validateStringArray(value, field, { allowEmpty = true } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    fail(`${field} 必须是${allowEmpty ? '' : '非空'}字符串数组`);
  }
  if (value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    fail(`${field} 必须是${allowEmpty ? '' : '非空'}字符串数组`);
  }
  return value;
}

function validateActivation(activation, skillId, targetPackages) {
  const value = activation ?? {};
  const taskKeywords = validateStringArray(
    value.taskKeywords ?? [],
    `${skillId}.activation.taskKeywords`,
  );
  const intents = validateStringArray(
    value.intents ?? [],
    `${skillId}.activation.intents`,
  );
  const packages = validateStringArray(
    value.packages ?? targetPackages,
    `${skillId}.activation.packages`,
  );
  const manufacturers = validateStringArray(
    value.manufacturers ?? ['*'],
    `${skillId}.activation.manufacturers`,
    { allowEmpty: false },
  );
  const androidApiMin = value.androidApiMin ?? 26;
  assertInteger(androidApiMin, `${skillId}.activation.androidApiMin`, 1);
  if (value.taskScoped != null && typeof value.taskScoped !== 'boolean') {
    fail(`${skillId}.activation.taskScoped 必须是布尔值`);
  }
  if (value.surfaceScoped != null && typeof value.surfaceScoped !== 'boolean') {
    fail(`${skillId}.activation.surfaceScoped 必须是布尔值`);
  }
  return {
    intents,
    taskKeywords,
    packages,
    manufacturers,
    androidApiMin,
    taskScoped: value.taskScoped ?? false,
    surfaceScoped: value.surfaceScoped ?? packages.length > 0,
  };
}

async function loadSkill(entry) {
  assertString(entry?.id, 'manifest.skills[].id');
  assertSafeRelativePath(entry?.dir, `${entry.id}.dir`);

  const skillDir = path.join(SOURCE_DIR, entry.dir);
  const skillJson = await readJson(path.join(skillDir, 'skill.json'));
  const instructions = await readFile(path.join(skillDir, 'instructions.md'), 'utf8');

  if (skillJson.id !== entry.id) {
    fail(`清单 id ${entry.id} 与 ${entry.dir}/skill.json 的 id ${skillJson.id} 不一致`);
  }
  assertString(skillJson.id, `${entry.id}.id`);
  assertString(skillJson.name, `${entry.id}.name`);
  assertInteger(skillJson.version, `${entry.id}.version`, 1);
  const kind = skillJson.kind ?? 'app';
  if (!SKILL_KINDS.has(kind)) {
    fail(`${entry.id}.kind 不受支持: ${kind}`);
  }
  if (!entry.dir.startsWith(SKILL_DIR_PREFIX[kind])) {
    fail(`${entry.id}.dir 必须位于 ${SKILL_DIR_PREFIX[kind]} 下`);
  }
  const targetPackages = validateStringArray(
    skillJson.targetPackages ?? [],
    `${entry.id}.targetPackages`,
    { allowEmpty: kind !== 'app' },
  );
  const activation = validateActivation(skillJson.activation, entry.id, targetPackages);
  const capabilities = validateStringArray(
    skillJson.capabilities ?? [],
    `${entry.id}.capabilities`,
  );

  const subskills = [];
  const seenSubskillIds = new Set();
  for (const [index, subskill] of (skillJson.subskills ?? []).entries()) {
    assertString(subskill?.id, `${entry.id}.subskills[${index}].id`);
    assertString(subskill?.name, `${entry.id}.subskills[${index}].name`);
    assertSafeRelativePath(subskill?.file, `${entry.id}.subskills[${index}].file`);
    if (!subskill.file.startsWith('references/') || !subskill.file.endsWith('.md')) {
      fail(`${entry.id}.${subskill.id}.file 必须指向 references/*.md`);
    }
    if (seenSubskillIds.has(subskill.id)) {
      fail(`${entry.id} 存在重复子技能 id: ${subskill.id}`);
    }
    seenSubskillIds.add(subskill.id);
    if (
      !Array.isArray(subskill.keywords) ||
      subskill.keywords.some((item) => typeof item !== 'string' || item === '')
    ) {
      fail(`${entry.id}.${subskill.id}.keywords 必须是字符串数组`);
    }
    const content = await readFile(path.join(skillDir, subskill.file), 'utf8');
    subskills.push({
      id: subskill.id,
      name: subskill.name,
      file: subskill.file,
      keywords: subskill.keywords,
      content,
      priority: subskill.priority ?? 0,
      requiresCapabilities: validateStringArray(
        subskill.requiresCapabilities ?? [],
        `${entry.id}.${subskill.id}.requiresCapabilities`,
      ),
    });
  }

  return {
    id: skillJson.id,
    kind,
    targetPackages,
    name: skillJson.name,
    version: skillJson.version,
    instructions,
    activation,
    capabilities,
    examples: validateExamples(skillJson.examples, entry.id),
    subskills,
    priority: skillJson.priority ?? 0,
    author: skillJson.author ?? 'system',
  };
}

async function buildArtifacts() {
  const manifest = await readJson(path.join(SOURCE_DIR, 'manifest.json'));
  if (manifest.schemaVersion !== 2) fail('schemaVersion 必须为 2');
  assertInteger(manifest.bundleVersion, 'bundleVersion', 1);
  assertString(manifest.minAppVersion, 'minAppVersion');
  if (!Array.isArray(manifest.skills) || manifest.skills.length === 0) {
    fail('manifest.skills 必须是非空数组');
  }

  const seenIds = new Set();
  for (const entry of manifest.skills) {
    if (seenIds.has(entry.id)) fail(`清单存在重复技能 id: ${entry.id}`);
    seenIds.add(entry.id);
  }

  const skills = [];
  for (const entry of manifest.skills) {
    skills.push(await loadSkill(entry));
  }

  const bundle = {
    schemaVersion: manifest.schemaVersion,
    bundleVersion: manifest.bundleVersion,
    minAppVersion: manifest.minAppVersion,
    skills,
  };
  const bundleText = `${JSON.stringify(bundle, null, 2)}\n`;
  const digest = createHash('sha256').update(bundleText).digest('hex');
  const generatedManifest = {
    schemaVersion: manifest.schemaVersion,
    bundleVersion: manifest.bundleVersion,
    minAppVersion: manifest.minAppVersion,
    digestAlgorithm: 'SHA-256',
    digest,
    skills: skills.map((skill) => ({
      id: skill.id,
      kind: skill.kind,
      version: skill.version,
      targetPackages: skill.targetPackages,
    })),
  };
  return {
    sourceManifest: manifest,
    bundleText,
    manifestText: `${JSON.stringify(generatedManifest, null, 2)}\n`,
    digest,
  };
}

async function assertFileEquals(filePath, expected) {
  let actual;
  try {
    actual = await readFile(filePath, 'utf8');
  } catch {
    fail(`缺少生成文件: ${path.relative(ROOT, filePath)}`);
  }
  if (actual !== expected) {
    fail(`生成文件已过期: ${path.relative(ROOT, filePath)}，请运行 npm run phone-skills:build`);
  }
}

function androidManifestText(sourceManifest) {
  return `${JSON.stringify({
    version: sourceManifest.bundleVersion,
    skills: sourceManifest.skills.map(({ id, dir }) => ({ id, dir })),
  }, null, 2)}\n`;
}

function androidSourceLockText(sourceManifest, digest) {
  return `${JSON.stringify({
    source: '@youngclaw/tabby-control/phone-skills',
    schemaVersion: sourceManifest.schemaVersion,
    bundleVersion: sourceManifest.bundleVersion,
    digestAlgorithm: 'SHA-256',
    digest,
  }, null, 2)}\n`;
}

async function syncAndroidAssets(targetDir, artifacts) {
  const absoluteTarget = path.resolve(ROOT, targetDir);
  await rm(absoluteTarget, { recursive: true, force: true });
  await mkdir(absoluteTarget, { recursive: true });
  for (const entry of artifacts.sourceManifest.skills) {
    await cp(path.join(SOURCE_DIR, entry.dir), path.join(absoluteTarget, entry.dir), {
      recursive: true,
      force: true,
    });
  }
  await writeFile(
    path.join(absoluteTarget, 'manifest.json'),
    androidManifestText(artifacts.sourceManifest),
    'utf8',
  );
  await writeFile(
    path.join(absoluteTarget, 'source-lock.json'),
    androidSourceLockText(artifacts.sourceManifest, artifacts.digest),
    'utf8',
  );
  console.log(`[phone-skills] Android 内置基线已同步到 ${absoluteTarget}`);
}

async function collectFiles(root, prefix = '') {
  const result = new Map();
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      for (const [childPath, childContent] of await collectFiles(absolute, relative)) {
        result.set(childPath, childContent);
      }
    } else if (entry.isFile()) {
      result.set(relative, await readFile(absolute, 'utf8'));
    }
  }
  return result;
}

async function checkAndroidAssets(targetDir, artifacts) {
  const absoluteTarget = path.resolve(ROOT, targetDir);
  try {
    if (!(await stat(absoluteTarget)).isDirectory()) fail(`Android 资产目录不存在: ${absoluteTarget}`);
  } catch {
    fail(`Android 资产目录不存在: ${absoluteTarget}`);
  }

  const expected = new Map();
  expected.set('manifest.json', androidManifestText(artifacts.sourceManifest));
  expected.set('source-lock.json', androidSourceLockText(artifacts.sourceManifest, artifacts.digest));
  for (const entry of artifacts.sourceManifest.skills) {
    const sourceFiles = await collectFiles(path.join(SOURCE_DIR, entry.dir));
    for (const [relative, content] of sourceFiles) {
      expected.set(`${entry.dir}/${relative}`, content);
    }
  }

  const actual = await collectFiles(absoluteTarget);
  const expectedPaths = [...expected.keys()].sort();
  const actualPaths = [...actual.keys()].sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    fail(`Android 资产文件清单与技能源不一致: ${absoluteTarget}`);
  }
  for (const [relative, content] of expected) {
    if (actual.get(relative) !== content) {
      fail(`Android 资产内容已漂移: ${path.join(absoluteTarget, relative)}`);
    }
  }
  console.log(`[phone-skills] Android 内置基线校验通过: ${absoluteTarget}`);
}

const artifacts = await buildArtifacts();
if (args.includes('--check')) {
  await assertFileEquals(BUNDLE_PATH, artifacts.bundleText);
  await assertFileEquals(GENERATED_MANIFEST_PATH, artifacts.manifestText);
  console.log(`[phone-skills] 生成产物校验通过，bundleVersion=${artifacts.sourceManifest.bundleVersion}`);
} else {
  await mkdir(GENERATED_DIR, { recursive: true });
  await writeFile(BUNDLE_PATH, artifacts.bundleText, 'utf8');
  await writeFile(GENERATED_MANIFEST_PATH, artifacts.manifestText, 'utf8');
  console.log(
    `[phone-skills] bundle 已生成，version=${artifacts.sourceManifest.bundleVersion}, digest=${artifacts.digest}`,
  );
}

const androidTarget = getArgValue('--android-assets');
if (androidTarget) await syncAndroidAssets(androidTarget, artifacts);

const androidCheckTarget = getArgValue('--check-android-assets');
if (androidCheckTarget) await checkAndroidAssets(androidCheckTarget, artifacts);
