import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function computeSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Zips the staged bundle directory into <outDir>/<slug>-<targetOs>.zip
 * while preserving POSIX permissions and symlinks (-r -y -q).
 * Extracts cleanly into a single top-level folder <bundleFolderName>/.
 */
export async function archiveBundle({ stageDir, outDir, slug, targetOs }) {
  await fsp.mkdir(outDir, { recursive: true });

  const zipFileName = `${slug}-${targetOs}.zip`;
  const zipPath = path.join(outDir, zipFileName);

  // Remove any stale zip at the target path before creating a fresh one
  await fsp.rm(zipPath, { force: true }).catch(() => {});

  const parentDir = path.dirname(stageDir);
  const folderName = path.basename(stageDir);

  await execFileAsync('zip', ['-r', '-y', '-q', zipPath, folderName], {
    cwd: parentDir,
    maxBuffer: 20 * 1024 * 1024,
  });

  const stat = await fsp.stat(zipPath);
  const sha256 = await computeSha256(zipPath);

  return {
    zipPath,
    zipFileName,
    zipSizeBytes: stat.size,
    sha256,
  };
}
