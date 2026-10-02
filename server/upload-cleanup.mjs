import fs from 'node:fs/promises';
import path from 'node:path';

const walkFiles = async (directory) => {
  const entries = await fs.readdir(directory, {withFileTypes: true}).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
};

export const cleanupOldUploads = async ({
  uploadRoot,
  retentionHours = 24,
  now = Date.now(),
}) => {
  const cutoff = now - Math.max(1, Number(retentionHours) || 24) * 60 * 60 * 1000;
  const files = await walkFiles(uploadRoot);
  let removedFiles = 0;
  let removedBytes = 0;
  for (const filePath of files) {
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat || stat.mtimeMs >= cutoff) continue;
    await fs.unlink(filePath).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    removedFiles += 1;
    removedBytes += stat.size;
  }
  return {removedFiles, removedBytes};
};

export const startUploadCleanup = ({uploadRoot, retentionHours = 24, intervalHours = 1}) => {
  const run = async () => {
    try {
      const result = await cleanupOldUploads({uploadRoot, retentionHours});
      if (result.removedFiles) {
        console.log(`[dọn upload] Đã xóa ${result.removedFiles} file cũ (${Math.round(result.removedBytes / 1024 / 1024)} MB).`);
      }
    } catch (error) {
      console.warn(`[dọn upload] ${error.message}`);
    }
  };
  void run();
  const timer = setInterval(run, Math.max(1, intervalHours) * 60 * 60 * 1000);
  timer.unref();
  return timer;
};
