import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkExpectedResult } from '../scripts/release-gate-result-checks.mjs';

test('keeps completed success as the default result contract', () => {
  assert.deepEqual(checkExpectedResult({ success: true, status: 'completed' }), []);
});

test('requires the configured artifact count and MIME type', () => {
  const mismatches = checkExpectedResult(
    { success: true, status: 'completed', artifacts: [] },
    { minArtifacts: 1, artifactMimeTypes: ['image/jpeg'] },
  );

  assert.equal(mismatches.length, 2);
  assert.match(mismatches[0], /artifacts=0/);
  assert.match(mismatches[1], /image\/jpeg/);
});

test('accepts a persisted artifact above the byte threshold', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tabby-artifact-'));
  try {
    const artifactPath = path.join(directory, 'capture.jpg');
    await writeFile(artifactPath, Buffer.alloc(2048, 1));
    const mismatches = checkExpectedResult(
      {
        success: true,
        status: 'completed',
        artifacts: [{ name: 'capture', mimeType: 'image/jpeg', path: artifactPath }],
      },
      {
        minArtifacts: 1,
        artifactMimeTypes: ['image/jpeg'],
        requireArtifactFiles: true,
        minArtifactBytes: 1024,
      },
    );

    assert.deepEqual(mismatches, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects missing and undersized artifact files', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tabby-artifact-'));
  try {
    const smallPath = path.join(directory, 'small.jpg');
    await writeFile(smallPath, Buffer.alloc(8, 1));
    const mismatches = checkExpectedResult(
      {
        success: true,
        status: 'completed',
        artifacts: [
          { name: 'missing', mimeType: 'image/jpeg', path: path.join(directory, 'missing.jpg') },
          { name: 'small', mimeType: 'image/jpeg', path: smallPath },
        ],
      },
      { requireArtifactFiles: true, minArtifactBytes: 1024 },
    );

    assert.equal(mismatches.length, 2);
    assert.match(mismatches[0], /文件不存在/);
    assert.match(mismatches[1], /仅 8 字节/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
