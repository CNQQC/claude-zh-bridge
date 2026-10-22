import { readFile, mkdir, copyFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const extension = path.join(root, 'extension');
const bridge = path.join(root, 'desktop/bridge');
const config = await readFile(path.join(extension, 'private-config.js'), 'utf8');
if (!/apiKey:\s*['"]['"]/.test(config) || /sk-[A-Za-z0-9_-]{16,}/.test(config)) throw new Error('Public builds must not embed a provider key.');
await mkdir(path.join(bridge, 'extension'), { recursive: true });
for (const name of await readdir(extension)) {
  if (/\.(?:js|html|css)$/.test(name)) await copyFile(path.join(extension, name), path.join(bridge, 'extension', name));
}
await writeFile(path.join(bridge, 'extension/private-config.js'), "self.CztPrivateConfig={apiKey:''};\n");
execFileSync(process.execPath, ['build.cjs'], { cwd: bridge, stdio: 'inherit' });
console.log('Public extension and isolated desktop bridge built without credentials.');
