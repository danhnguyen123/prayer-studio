import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {cleanupOldUploads} from './upload-cleanup.mjs';

test('upload cleanup removes expired files and preserves recent files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prayer-upload-cleanup-'));
  try {
    const oldFile = path.join(root, 'old.mp3');
    const recentFile = path.join(root, 'recent.srt');
    await fs.writeFile(oldFile, 'old');
    await fs.writeFile(recentFile, 'recent');
    const now = Date.now();
    const oldDate = new Date(now - 25 * 60 * 60 * 1000);
    await fs.utimes(oldFile, oldDate, oldDate);

    const result = await cleanupOldUploads({uploadRoot: root, retentionHours: 24, now});
    assert.equal(result.removedFiles, 1);
    await assert.rejects(fs.access(oldFile));
    await fs.access(recentFile);
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
});
