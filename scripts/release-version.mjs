import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const [root, version] = process.argv.slice(2);
if (!root || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '')
    || version.split('.').some(part => Number(part) > 65535) || version === '0.0.0') {
  throw new Error('Expected repository path and numeric version X.Y.Z.');
}
const files = ['package.json', 'package-lock.json'].map(name => {
  const filename = path.join(root, name);
  const original = fs.readFileSync(filename);
  const value = JSON.parse(original.toString('utf8'));
  return { filename, original, value, temporary: `${filename}.release-${randomUUID()}.tmp`, written: false };
});
if (files[0].value.version !== files[1].value.version) throw new Error('Package and lockfile versions differ.');
files[0].value.version = version;
files[1].value.version = version;
if (files[1].value.packages?.['']) files[1].value.packages[''].version = version;
try {
  // Prepare both files before replacing either original; restore partial replacements on failure.
  for (const file of files) {
    file.updated = Buffer.from(JSON.stringify(file.value, null, 2) + '\n');
    fs.writeFileSync(file.temporary, file.updated, { flag: 'wx' });
  }
  for (const file of files) {
    if (!fs.readFileSync(file.filename).equals(file.original)) throw new Error('Version files changed during the update.');
    fs.renameSync(file.temporary, file.filename);
    file.written = true;
  }
} catch (error) {
  for (const file of files.filter(file => file.written)) {
    if (fs.readFileSync(file.filename).equals(file.updated)) fs.writeFileSync(file.filename, file.original);
  }
  throw error;
} finally {
  for (const file of files) fs.rmSync(file.temporary, { force: true });
}
