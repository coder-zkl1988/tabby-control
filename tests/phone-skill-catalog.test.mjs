import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PhoneSkillCatalog } from '../dist/phone-skill-catalog.js';

async function createHarness() {
  const bundleText = await readFile(
    new URL('../generated/phone-skills.bundle.json', import.meta.url),
    'utf8',
  );
  const manifest = JSON.parse(
    await readFile(
      new URL('../generated/phone-skills.manifest.json', import.meta.url),
      'utf8',
    ),
  );
  const sent = [];
  const patches = [];
  const catalog = new PhoneSkillCatalog({
    bundleText,
    manifest,
    sendToDevice(deviceId, message) {
      sent.push({ deviceId, message });
      return true;
    },
    updateDeviceStatus(deviceId, patch) {
      patches.push({ deviceId, patch });
    },
  });
  return { bundleText, manifest, catalog, sent, patches };
}

test('stale phone receives digest-addressed v2 bundle plus legacy skill list', async () => {
  const { bundleText, manifest, catalog, sent, patches } = await createHarness();
  assert.equal(catalog.handleMessage('phone-1', {
    channel: 'skill',
    method: 'skill.hello',
    params: {
      schemaVersion: 2,
      bundleVersion: 0,
      digest: '',
      appVersion: manifest.minAppVersion,
    },
  }), true);

  assert.equal(sent.length, 1);
  const sync = sent[0].message;
  assert.equal(sync.type, 'skill.sync');
  assert.equal(sync.method, 'skill.sync');
  assert.equal(sync.params.schemaVersion, 2);
  assert.equal(sync.params.bundleVersion, manifest.bundleVersion);
  assert.equal(sync.params.digest, manifest.digest);
  assert.equal(sync.params.skills.length, manifest.skills.length);
  const decoded = Buffer.from(sync.params.bundleBase64, 'base64').toString('utf8');
  assert.equal(decoded, bundleText);
  assert.equal(
    createHash('sha256').update(decoded).digest('hex'),
    manifest.digest,
  );
  assert.equal(patches.at(-1).patch.skillSyncStatus, 'syncing');
});

test('phone with matching bundle does not receive a redundant sync', async () => {
  const { manifest, catalog, sent, patches } = await createHarness();
  catalog.handleMessage('phone-1', {
    channel: 'skill',
    type: 'skill.hello',
    params: {
      schemaVersion: 2,
      bundleVersion: manifest.bundleVersion,
      digest: manifest.digest,
      appVersion: manifest.minAppVersion,
    },
  });

  assert.equal(sent.length, 0);
  assert.equal(patches.at(-1).patch.skillSyncStatus, 'current');
  assert.equal(typeof patches.at(-1).patch.skillLastSyncedAt, 'number');
});

test('phone below min app version is reported without sending an incompatible bundle', async () => {
  const { manifest, catalog, sent, patches } = await createHarness();
  catalog.handleMessage('phone-old', {
    channel: 'skill',
    method: 'skill.hello',
    params: {
      schemaVersion: 2,
      bundleVersion: 0,
      digest: '',
      appVersion: '1.0.13',
    },
  });

  assert.equal(sent.length, 0);
  assert.equal(patches.at(-1).patch.skillSyncStatus, 'incompatible');
  assert.match(
    patches.at(-1).patch.skillSyncError,
    new RegExp(manifest.minAppVersion.replaceAll('.', '\\.')),
  );
});

test('ack and nack are reflected in desktop device status', async () => {
  const { manifest, catalog, patches } = await createHarness();
  catalog.handleMessage('phone-1', {
    channel: 'skill',
    method: 'skill.ack',
    params: {
      schemaVersion: 2,
      bundleVersion: manifest.bundleVersion,
      digest: manifest.digest,
    },
  });
  assert.equal(patches.at(-1).patch.skillSyncStatus, 'current');

  catalog.handleMessage('phone-1', {
    channel: 'skill',
    method: 'skill.nack',
    params: {
      schemaVersion: 2,
      bundleVersion: manifest.bundleVersion,
      digest: manifest.digest,
      activeSchemaVersion: 2,
      activeBundleVersion: manifest.bundleVersion - 1,
      activeDigest: 'last-valid-digest',
      code: 'SKILL_VALIDATION_FAILED',
      message: '摘要校验失败',
    },
  });
  assert.equal(patches.at(-1).patch.skillSyncStatus, 'error');
  assert.match(patches.at(-1).patch.skillSyncError, /摘要校验失败/);
  assert.equal(patches.at(-1).patch.skillBundleVersion, manifest.bundleVersion - 1);
  assert.equal(patches.at(-1).patch.skillDigest, 'last-valid-digest');
});
