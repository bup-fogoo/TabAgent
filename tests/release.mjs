// Release checks run against an in-memory GitHub fake and disposable local files.
// Never publish a release, read credentials, or build the extension from this test.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'tabagent-release-test-'));
const environment = { ...process.env };
for (const key of Object.keys(environment)) {
  // PowerShell 7's module path must not leak into the Windows PowerShell 5.1 child.
  if (/^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|PSModulePath)$/i.test(key)) delete environment[key];
}

try {
  const versionRoot = path.join(fixture, 'version-update');
  await fs.mkdir(versionRoot);
  const names = ['package.json', 'package-lock.json'];
  async function prepareVersionFiles(lockVersion = '0.1.0') {
    const contents = [
      '{ "name": "tabagent", "version": "0.1.0", "private": true }\n',
      JSON.stringify({ name: 'tabagent', version: lockVersion, lockfileVersion: 3,
        packages: { '': { name: 'tabagent', version: lockVersion }, 'node_modules/fixture': { version: '3.2.1' } } }, null, 4) + '\n',
    ];
    await Promise.all(names.map((name, index) => fs.writeFile(path.join(versionRoot, name), contents[index])));
    return contents;
  }
  function updateVersion(version, options = []) {
    const result = spawnSync(process.execPath, [...options, path.join(root, 'scripts', 'release-version.mjs'), versionRoot, version], {
      cwd: fixture, env: environment, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
    });
    assert.equal(result.error, undefined, result.error?.message);
    return result;
  }
  async function assertVersionFilesUnchanged(contents) {
    const actual = await Promise.all(names.map(name => fs.readFile(path.join(versionRoot, name), 'utf8')));
    assert.deepEqual(actual, contents, 'failed updates preserve both files byte for byte');
    assert.deepEqual((await fs.readdir(versionRoot)).sort(), [...names].sort(), 'temporary version files are removed');
  }

  await prepareVersionFiles();
  let result = updateVersion('0.2.0');
  assert.equal(result.status, 0, result.stderr);
  const [updatedPackage, updatedLock] = await Promise.all(names.map(async name => JSON.parse(await fs.readFile(path.join(versionRoot, name), 'utf8'))));
  assert.equal(updatedPackage.version, '0.2.0');
  assert.equal(updatedPackage.private, true);
  assert.equal(updatedLock.version, '0.2.0');
  assert.equal(updatedLock.packages[''].version, '0.2.0');
  assert.equal(updatedLock.packages['node_modules/fixture'].version, '3.2.1');
  for (const invalid of ['v0.2.0', '0.02.0', '0.0.0', '65536.0.0', '0.2.0-beta', '0.2.0;echo fixture']) {
    const contents = await prepareVersionFiles();
    result = updateVersion(invalid);
    assert.notEqual(result.status, 0, `invalid version ${invalid} must fail`);
    await assertVersionFilesUnchanged(contents);
  }
  let contents = await prepareVersionFiles('0.0.9');
  result = updateVersion('0.2.0');
  assert.notEqual(result.status, 0, 'inconsistent package and lockfile versions must fail');
  assert.match(result.stderr, /versions differ/);
  await assertVersionFilesUnchanged(contents);

  const faultModule = path.join(fixture, 'fail-second-rename.mjs');
  await fs.writeFile(faultModule, `import fs from 'node:fs';
const rename = fs.renameSync;
let calls = 0;
fs.renameSync = (...args) => {
  if (++calls === 2) throw new Error('Simulated second rename failure');
  return rename(...args);
};
`);
  contents = await prepareVersionFiles();
  result = updateVersion('0.2.0', ['--import', pathToFileURL(faultModule).href]);
  assert.notEqual(result.status, 0, 'injected second rename must fail');
  assert.match(result.stderr, /Simulated second rename failure/);
  await assertVersionFilesUnchanged(contents);
  console.log('PASS version helper updates both manifests and rolls back partial replacement');

  if (process.platform !== 'win32') {
    console.log('SKIP Windows PowerShell release workflow (requires Windows).');
  } else {
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const help = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(root, 'scripts', 'release.ps1'), '-Help'], {
      cwd: root, env: environment, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
    });
    assert.equal(help.error, undefined, help.error?.message);
    assert.equal(help.status, 0, `${help.stdout || ''}\n${help.stderr || ''}`);
    for (const mode of ['-Quick', '-Stable', '-PackageOnly', '-Check', '-Resume']) {
      assert.ok(help.stdout.includes(mode), `help documents ${mode}`);
    }
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(root, 'tests', 'release-fixture.ps1'), '-RepositoryRoot', root, '-FixtureRoot', fixture], {
      cwd: root, env: environment, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${result.stdout || ''}\n${result.stderr || ''}`);
    assert.match(result.stdout, /Release workflow checks passed/);
    console.log(result.stdout.trim());
  }
} finally {
  const parent = await fs.realpath(os.tmpdir());
  const resolved = await fs.realpath(fixture);
  assert.equal(path.dirname(resolved).toLowerCase(), parent.toLowerCase(), 'cleanup stays in the temp directory');
  assert.ok(path.basename(resolved).startsWith('tabagent-release-test-'));
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
