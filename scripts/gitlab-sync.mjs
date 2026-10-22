import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import https from 'node:https';

const ROOT = 'D:/git/iot/sensor';
const GROUPS = ['lora', 'cellular', 'lib'];

function fetch(url, token) {
  return new Promise((resolve) => {
    https.get(url, { headers: { 'PRIVATE-TOKEN': token } }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)) } catch { resolve([]) } });
    }).on('error', () => resolve([]));
  });
}

async function main() {
  const pass = process.argv[2];
  if (!pass) { console.error('usage: node gitlab-sync.mjs <token>'); process.exit(1); }

  // enumerate remote
  const remote = [];
  for (const g of GROUPS) {
    const page = await fetch(`https://gitlab.milesight.com/api/v4/groups/iot%2Fsensor%2F${g}/projects?per_page=100`, pass);
    remote.push(...page.map(p => ({
      path: p.path_with_namespace.replace('iot/sensor/', ''),
      url: p.http_url_to_repo,
      branch: p.default_branch || 'develop',
    })));
  }
  console.log('远端项目总数:', remote.length);

  // local
  const local = new Set();
  for (const g of GROUPS) {
    try {
      const entries = await readdir(join(ROOT, g), { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) local.add(`${g}/${e.name}`);
      }
    } catch { /* line dir may not exist */ }
  }

  const missing = remote.filter(p => !local.has(p.path));
  console.log('本地缺失:', missing.length, '个');
  missing.forEach(p => console.log(`  需 clone: ${p.path} (默认分支: ${p.branch})`));

  // output clone commands
  if (missing.length > 0) {
    console.log('\nClone 命令:');
    for (const p of missing) {
      console.log(`git clone --branch ${p.branch} ${p.url} ${ROOT}/${p.path}`);
    }
  }
}

main();
