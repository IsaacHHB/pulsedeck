import { packager } from '@electron/packager';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const result = await packager({
  dir: root, name: 'PulseDeck', platform: 'win32', arch: 'x64',
  out: path.join(root, '..', 'release'), overwrite: true, asar: true,
  icon: path.join(root, 'icon.ico'),
  appVersion: '0.5.0', appCopyright: 'PulseDeck',
  win32metadata: { CompanyName: 'Personal project', FileDescription: 'PulseDeck soundboard and microphone mixer', ProductName: 'PulseDeck' },
  download: { cacheRoot: path.join(root, '..', 'electron-cache') },
  ignore: [/^\/tests($|\/)/, /^\/test-results($|\/)/, /^\/PulseDeck Data($|\/)/, /^\/user-data($|\/)/, /^\/build\.mjs$/, /^\/make-icon\.cjs$/, /^\/README\.md$/]
});
console.log(result.join('\n'));
