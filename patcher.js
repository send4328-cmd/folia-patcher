#!/usr/bin/env node
// Folia patcher: applies the rule packs in ./packs to Folia's resources/app.asar.
// No dependencies; Node 18+. Usage: node patcher.js [status|install|uninstall|restore-backup] [pack ids|all] [--folia <dir>] [--yes]
'use strict';
// When run through Folia.exe (ELECTRON_RUN_AS_NODE), Electron would treat app.asar as a directory.
process.noAsar = true;
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { execFileSync } = require('child_process');

const PACK_DIR = path.join(__dirname, 'packs');
const BACKUP_SUFFIX = '.folia-patcher.bak';
const BLOCK = 4 * 1024 * 1024;

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ---------- asar ----------

const readAsar = (file) => {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  if (head.readUInt32LE(0) !== 4) throw new Error('不是有效的 asar 文件');
  const pickleSize = head.readUInt32LE(4);
  const strLen = head.readUInt32LE(12);
  const json = Buffer.alloc(strLen);
  fs.readSync(fd, json, 0, strLen, 16);
  return { fd, header: JSON.parse(json.toString('utf8')), base: 8 + pickleSize };
};

const getEntry = (header, rel) => {
  let node = header;
  for (const seg of rel.split('/')) {
    node = node.files && node.files[seg];
    if (!node) return null;
  }
  return node.offset === undefined || node.unpacked ? null : node;
};

const readEntry = (asar, entry) => {
  const buf = Buffer.alloc(entry.size);
  if (entry.size) fs.readSync(asar.fd, buf, 0, entry.size, asar.base + Number(entry.offset));
  return buf;
};

const integrity = (buf) => {
  const blocks = [];
  for (let i = 0; i < buf.length; i += BLOCK) blocks.push(sha(buf.subarray(i, i + BLOCK)));
  if (blocks.length === 0) blocks.push(sha(buf));
  return { algorithm: 'SHA256', hash: sha(buf), blockSize: BLOCK, blocks };
};

const collectEntries = (node, out = []) => {
  for (const child of Object.values(node.files || {})) {
    if (child.files) collectEntries(child, out);
    else if (child.offset !== undefined && !child.unpacked) out.push(child);
  }
  return out;
};

// Rewrites the archive with `replacements` (Map entry -> Buffer), keeping every other file's bytes.
const writeAsar = (asar, replacements, outFile) => {
  const entries = collectEntries(asar.header).sort((a, b) => Number(a.offset) - Number(b.offset));
  const plan = entries.map((e) => ({ e, from: Number(e.offset), size: e.size }));
  let offset = 0;
  for (const p of plan) {
    const data = replacements.get(p.e);
    if (data) {
      p.e.size = data.length;
      p.e.integrity = integrity(data);
    }
    p.e.offset = String(offset);
    offset += p.e.size;
  }
  const json = Buffer.from(JSON.stringify(asar.header), 'utf8');
  const padded = (json.length + 3) & ~3;
  const prefix = Buffer.alloc(16 + padded);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(8 + padded, 4);
  prefix.writeUInt32LE(4 + padded, 8);
  prefix.writeUInt32LE(json.length, 12);
  json.copy(prefix, 16);

  const out = fs.openSync(outFile, 'w');
  try {
    fs.writeSync(out, prefix);
    const chunk = Buffer.alloc(1024 * 1024);
    for (const p of plan) {
      const data = replacements.get(p.e);
      if (data) { fs.writeSync(out, data); continue; }
      let done = 0;
      while (done < p.size) {
        const n = fs.readSync(asar.fd, chunk, 0, Math.min(chunk.length, p.size - done), asar.base + p.from + done);
        if (n <= 0) throw new Error('读取 asar 时意外结束');
        fs.writeSync(out, chunk, 0, n);
        done += n;
      }
    }
  } finally {
    fs.closeSync(out);
  }
};

// ---------- packs ----------

const loadPacks = () =>
  fs.readdirSync(PACK_DIR).filter((f) => f.endsWith('.json')).sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(PACK_DIR, f), 'utf8')));

const countOf = (hay, needle) => {
  let n = 0, i = -1;
  while ((i = hay.indexOf(needle, i + 1)) !== -1) n++;
  return n;
};

// install: find -> replace; uninstall: replace -> find. Every source string must occur exactly once.
const applyRules = (text, rules, install) => {
  const hits = rules.map((r) => {
    const from = install ? r.find : r.replace;
    const to = install ? r.replace : r.find;
    if (countOf(text, from) !== 1) throw new Error('补丁位置对不上');
    return { at: text.indexOf(from), len: from.length, to };
  }).sort((a, b) => b.at - a.at);
  for (let i = 1; i < hits.length; i++) if (hits[i].at + hits[i].len > hits[i - 1].at) throw new Error('补丁位置重叠');
  for (const h of hits) text = text.slice(0, h.at) + h.to + text.slice(h.at + h.len);
  return text;
};

const packStatus = (asar, pack) => {
  const states = pack.files.map((f) => {
    const entry = getEntry(asar.header, f.path);
    if (!entry) return 'unknown';
    const h = sha(readEntry(asar, entry));
    return h === f.origSha ? 'off' : h === f.patchedSha ? 'on' : 'unknown';
  });
  if (states.every((s) => s === 'on')) return 'installed';
  if (states.every((s) => s === 'off')) return 'not-installed';
  return 'unknown';
};

const STATUS_TEXT = { installed: '已安装', 'not-installed': '未安装', unknown: '版本不匹配' };

// ---------- Folia location ----------

const asarIn = (p) => {
  if (!p) return null;
  const tries = [p, path.join(p, 'app.asar'), path.join(p, 'resources', 'app.asar')];
  return tries.find((t) => t.toLowerCase().endsWith('app.asar') && fs.existsSync(t)) || null;
};

const findFolia = (given) => {
  if (given) return asarIn(given);
  const roots = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Folia'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Folia'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Folia'),
  ];
  for (const d of 'CDEFGHIJ') roots.push(`${d}:\\Program Files\\Folia`, `${d}:\\Folia`);
  for (const r of roots) { const a = asarIn(r); if (a) return a; }
  return null;
};

const runningFoliaDirs = () => {
  if (process.platform !== 'win32') return [];
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      `Get-Process Folia -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne ${process.pid} } | ForEach-Object { $_.Path }`], { encoding: 'utf8' });
    return out.split(/\r?\n/).filter(Boolean).map((p) => path.dirname(p).toLowerCase());
  } catch { return []; }
};

// ---------- actions ----------

const showStatus = (asarFile, packs) => {
  const asar = readAsar(asarFile);
  try {
    console.log(`Folia：${asarFile}`);
    for (const p of packs) console.log(`  [${STATUS_TEXT[packStatus(asar, p)]}] ${p.id}  ${p.name}`);
  } finally { fs.closeSync(asar.fd); }
};

const change = (asarFile, packs, install) => {
  const foliaDir = path.dirname(path.dirname(asarFile)).toLowerCase();
  if (runningFoliaDirs().includes(foliaDir)) throw new Error('Folia 正在运行，请先完全退出（包括托盘图标）再试。');

  const asar = readAsar(asarFile);
  const replacements = new Map();
  const done = [];
  try {
    for (const p of packs) {
      const st = packStatus(asar, p);
      if (st === 'unknown') throw new Error(`「${p.name}」对应的文件和预期不一致。这个补丁只支持 Folia ${p.folia}，或者 Folia 已被其他方式改过。没有修改任何文件。`);
      if ((st === 'installed') === install) { console.log(`  跳过「${p.name}」：已经是${install ? '安装' : '未安装'}状态`); continue; }
      for (const f of p.files) {
        const entry = getEntry(asar.header, f.path);
        const out = Buffer.from(applyRules(readEntry(asar, entry).toString('utf8'), f.rules, install), 'utf8');
        if (sha(out) !== (install ? f.patchedSha : f.origSha)) throw new Error(`「${p.name}」修改结果校验失败，没有修改任何文件。`);
        replacements.set(entry, out);
      }
      done.push(`  ${install ? '已安装' : '已卸载'}「${p.name}」`);
    }
    if (replacements.size === 0) { console.log('没有需要修改的内容。'); return; }

    const backup = asarFile + BACKUP_SUFFIX;
    if (!fs.existsSync(backup)) {
      fs.copyFileSync(asarFile, backup);
      console.log(`已备份修改前的 app.asar：${backup}`);
    }
    const tmp = asarFile + '.folia-patcher.tmp';
    try {
      writeAsar(asar, replacements, tmp);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    fs.closeSync(asar.fd);
    asar.fd = null;
    fs.renameSync(tmp, asarFile);
  } finally {
    if (asar.fd !== null) fs.closeSync(asar.fd);
  }

  const check = readAsar(asarFile);
  try {
    for (const p of packs) {
      const st = packStatus(check, p);
      if (st !== (install ? 'installed' : 'not-installed')) throw new Error(`写入后校验失败（${p.id}）。可以用 restore-backup 还原备份。`);
    }
  } finally { fs.closeSync(check.fd); }
  done.forEach((line) => console.log(line));
  console.log('完成。重新打开 Folia 即可生效。');
};

const restoreBackup = (asarFile) => {
  const foliaDir = path.dirname(path.dirname(asarFile)).toLowerCase();
  if (runningFoliaDirs().includes(foliaDir)) throw new Error('Folia 正在运行，请先完全退出再试。');
  const backup = asarFile + BACKUP_SUFFIX;
  if (!fs.existsSync(backup)) throw new Error('没有找到备份文件：' + backup);
  fs.copyFileSync(backup, asarFile);
  console.log('已用备份还原 app.asar。');
};

// ---------- CLI ----------

const ask = (rl, q) => new Promise((res) => rl.question(q, (a) => res(a.trim())));

const pickPacks = (all, ids) => {
  if (ids.length === 0 || ids.includes('all')) return all;
  return ids.map((id) => {
    const p = all.find((x) => x.id === id);
    if (!p) throw new Error(`没有这个补丁包：${id}（可选：${all.map((x) => x.id).join('、')}）`);
    return p;
  });
};

const menu = async (asarGiven, packs) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    let asarFile = asarGiven;
    while (!asarFile) {
      const p = await ask(rl, '没有自动找到 Folia，请输入 Folia 的安装目录（或直接回车退出）：');
      if (!p) return;
      asarFile = asarIn(p.replace(/^"|"$/g, ''));
      if (!asarFile) console.log('这个目录里没有 resources\\app.asar。');
    }
    for (;;) {
      console.log('');
      showStatus(asarFile, packs);
      console.log('');
      packs.forEach((p, i) => console.log(`  ${i + 1}. 安装「${p.name}」`));
      console.log(`  ${packs.length + 1}. 全部安装`);
      console.log(`  ${packs.length + 2}. 全部卸载`);
      console.log(`  ${packs.length + 3}. 用备份还原 app.asar`);
      console.log('  0. 退出');
      const n = Number(await ask(rl, '请选择：'));
      try {
        if (n === 0 || Number.isNaN(n)) return;
        if (n >= 1 && n <= packs.length) change(asarFile, [packs[n - 1]], true);
        else if (n === packs.length + 1) change(asarFile, packs, true);
        else if (n === packs.length + 2) change(asarFile, packs, false);
        else if (n === packs.length + 3) restoreBackup(asarFile);
      } catch (e) {
        console.log('失败：' + (e.code === 'EPERM' || e.code === 'EACCES' ? '没有写入权限，请右键「以管理员身份运行」。' : e.message));
      }
    }
  } finally { rl.close(); }
};

const main = async () => {
  const args = process.argv.slice(2);
  const fi = args.indexOf('--folia');
  const given = fi >= 0 ? args.splice(fi, 2)[1] : null;
  const packs = loadPacks();
  const asarFile = findFolia(given);
  const [cmd, ...ids] = args.filter((a) => !a.startsWith('--'));
  if (!cmd) return menu(asarFile, packs);
  if (!asarFile) throw new Error(given ? `这个目录里没有 resources\\app.asar：${given}` : '没有找到 Folia，请用 --folia <安装目录> 指定。');
  if (cmd === 'status') return showStatus(asarFile, packs);
  if (cmd === 'install') return change(asarFile, pickPacks(packs, ids), true);
  if (cmd === 'uninstall') return change(asarFile, pickPacks(packs, ids), false);
  if (cmd === 'restore-backup') return restoreBackup(asarFile);
  throw new Error('未知命令：' + cmd);
};

main().catch((e) => {
  console.error('失败：' + (e.code === 'EPERM' || e.code === 'EACCES' ? '没有写入权限，请以管理员身份运行。' : e.message));
  process.exitCode = 1;
});
