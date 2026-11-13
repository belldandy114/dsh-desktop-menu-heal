/**
 * dsh-desktop-menu-heal — 桌面版「应用」菜单补丁的自愈插件
 *
 * 背景：桌面版标题栏「应用」下拉菜单里的「刷新页面 / 重启应用」两项，上游本来就内置，
 * 只是被 `const development = !app.isPackaged` 挡住，正式安装版永远不显示。
 * 补丁把这一行改成恒真，并把重启项标签缩短为「重启应用」。
 *
 * 问题：应用自动更新会把 app.asar 整体替换掉，补丁随之消失，于是每次更新后都得
 * 手动跑一遍安装脚本（还要点 UAC）。本插件在每次 Host 启动时检查 app.asar，
 * 发现补丁不在就自动补回去，因此更新之后再也不用动手。
 *
 * 写入方式与安装脚本一致：只改写 lib/main.js 自己那一段字节，且每一处替换的
 * 字节数严格相等 —— 归档文件头与其它所有文件的偏移都不变，对正在运行的进程零影响。
 *
 * 两道保险（v1.2.0 起）：
 *  1. 写之前先读 Electron 可执行文件的 fuse wire，确认 asar 完整性校验
 *     （EnableEmbeddedAsarIntegrityValidation）没被打开。打开时改写 app.asar
 *     会让应用启动失败，所以这种情况一律不写，只报告。
 *  2. 三处目标不再用精确字符串匹配，改成「正则定位 + 按字节数补空格」。
 *     上游压缩器换版本导致空白数量变化时仍然认得出来，替换后长度依旧严格相等。
 *
 * 重要：Host 以 `ELECTRON_RUN_AS_NODE=1` 运行，Electron 会把 `*.asar` 当成目录，
 * 直接用 fs 打开归档会报 `ENOENT, not found in ...app.asar`。所有归档读写因此
 * 都在 `process.noAsar = true` 下进行（见 withNoAsar）。
 *
 * 补丁在 Electron 主进程启动时就已经读进内存了，所以本次启动看不到变化，
 * 需要下一次启动桌面端才会生效。插件会在日志里明确提示。
 *
 * 关闭自愈：创建下面这个标记文件即可让插件跳过处理
 *   %LOCALAPPDATA%\DSHMenuPatch\disabled
 *
 * @module dsh-desktop-menu-heal
 */

import fs from 'node:fs';
import path from 'node:path';

export const name = 'dsh-desktop-menu-heal';
export const inject = [];

/** 目标归档条目。 */
const ENTRY_PATH = 'lib/main.js';

/** 明确指定归档位置的环境变量（可选）。 */
const ASAR_ENV = 'DSH_DESKTOP_APP_ASAR';

/** 中日韩字符判定：用来区分中英文标签。 */
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

/** 缩短后的重启项标签。 */
const SHORT_LABEL = { zh: '重启应用', en: 'Restart App' };

/** 旧标签里一定带这个词，用它确认「还没被缩短」。 */
const LONG_LABEL_HINT = 'Host';

/**
 * 在文本里定位「还没打补丁」的重启项标签。
 * 允许冒号后的空白数量变化（压缩器换版本时常见），并按字节数补齐空格。
 * @param text - lib/main.js 全文。
 * @param target - 缩短后的标签。
 * @param wantCjk - true 表示只处理中文标签，false 表示只处理英文标签。
 * @returns 定位结果，或 null。
 */
function locateRename(text, target, wantCjk) {
  const pattern = /restartAppHostMenu:(\s*)"([^"]*)",/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const label = match[2];
    if (!label.includes(LONG_LABEL_HINT)) continue;
    if (CJK.test(label) !== wantCjk) continue;
    const base = `restartAppHostMenu:"${target}",`;
    const room = Buffer.byteLength(match[0], 'utf8') - Buffer.byteLength(base, 'utf8');
    if (room < 0) return null;
    return {
      start: match.index,
      end: match.index + match[0].length,
      replacement: `restartAppHostMenu:${' '.repeat(room)}"${target}",`,
    };
  }
  return null;
}

/**
 * 在文本里定位被开发模式判断挡住的菜单数组。
 * 允许 `development` 与 `?`、`?` 与 `[` 之间的空白数量变化。
 * @param text - lib/main.js 全文。
 * @returns 定位结果，或 null。
 */
function locateUngate(text) {
  const match = /\.\.\.development\s*\?\s*\[/.exec(text);
  if (match === null) return null;
  const base = '...true ? /*' + '*/[';
  const room = Buffer.byteLength(match[0], 'utf8') - Buffer.byteLength(base, 'utf8');
  if (room < 0) return null;
  return {
    start: match.index,
    end: match.index + match[0].length,
    replacement: `...true ? /*${' '.repeat(room)}*/[`,
  };
}

/**
 * 全部补丁规则。
 *  - locate(text)：找「还没打补丁」的目标，返回 { start, end, replacement }；
 *    replacement 的 UTF-8 字节数由 locate 保证与 start..end 完全相等。
 *  - isDone(text)：补丁是否已经在这个文本里（用于幂等判断）。
 */
const RULES = [
  {
    id: 'ungate',
    locate: locateUngate,
    isDone: (text) => text.includes('...true ? /*'),
  },
  {
    id: 'rename-zh',
    locate: (text) => locateRename(text, SHORT_LABEL.zh, true),
    isDone: (text) => new RegExp(`restartAppHostMenu:\\s*"${SHORT_LABEL.zh}",`).test(text),
  },
  {
    id: 'rename-en',
    locate: (text) => locateRename(text, SHORT_LABEL.en, false),
    isDone: (text) => new RegExp(`restartAppHostMenu:\\s*"${SHORT_LABEL.en}",`).test(text),
  },
];

/**
 * 加载时自检：每条规则必须能认出自己的样本，且替换前后字节数严格相等。
 * 任何一条不满足就直接拒绝加载，绝不写坏归档。
 */
const SAMPLES = {
  ungate: '...development ? [',
  'rename-zh': 'restartAppHostMenu: "重启应用与 Host",',
  'rename-en': 'restartAppHostMenu: "Restart App and Host",',
};

for (const rule of RULES) {
  const sample = SAMPLES[rule.id];
  const hit = rule.locate(sample);
  if (hit === null) {
    throw new Error(`dsh-desktop-menu-heal: rule "${rule.id}" cannot locate its own sample`);
  }
  const before = Buffer.byteLength(sample.slice(hit.start, hit.end), 'utf8');
  const after = Buffer.byteLength(hit.replacement, 'utf8');
  if (before !== after) {
    throw new Error(
      `dsh-desktop-menu-heal: rule "${rule.id}" is not byte-length neutral (${before} != ${after})`,
    );
  }
  if (!rule.isDone(hit.replacement)) {
    throw new Error(`dsh-desktop-menu-heal: rule "${rule.id}" does not recognise its own output`);
  }
}

/** Electron fuse wire 的固定 sentinel。 */
const FUSE_SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'latin1');

/** EnableEmbeddedAsarIntegrityValidation 在 fuse 列表中的下标。 */
const FUSE_ASAR_INTEGRITY = 4;

/** fuse 状态字节：0x31 启用、0x30 关闭、0x72 已移除。 */
const FUSE_STATE = { 0x31: 'enabled', 0x30: 'disabled', 0x72: 'removed' };

/** fuse 状态的中文说明。 */
const FUSE_TEXT = {
  enabled: '启用（已阻止写入）',
  disabled: '关闭',
  removed: '已移除',
  unknown: '未知（未找到可执行文件）',
};

/** 用户主动停用时创建的标记文件，存在则插件不做事。 */
function stateDir() {
  const base = process.env.LOCALAPPDATA ?? process.env.HOME ?? '';
  return base === '' ? null : path.join(base, 'DSHMenuPatch');
}

function disabledMarkerPath() {
  const dir = stateDir();
  return dir === null ? null : path.join(dir, 'disabled');
}

/** 最近一次运行结果，写成一个小文本文件，用户不用翻日志就能看到插件干了什么。 */
function lastRunPath() {
  const dir = stateDir();
  return dir === null ? null : path.join(dir, 'last-run.txt');
}

/** 覆盖写入最近一次运行结果；任何失败都静默忽略。 */
function writeLastRun(lines) {
  try {
    const target = lastRunPath();
    if (target === null) return;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${lines.join('\n')}\n`, 'utf8');
  } catch {
    /* 状态文件只是方便查看，写不了也不影响自愈 */
  }
}

/** 各状态对应的中文说明。 */
const STATUS_TEXT = {
  healed: (r) => `已自动修复补丁（${(r.applied ?? []).join(', ')}）—— 需要在下次启动 DeepSeek Harness 后才能看到「应用」菜单的变化`,
  intact: () => '补丁完好，未做任何修改',
  upstream: () => '没找到旧的开发模式判断，但菜单项还在 —— 上游可能已经自己放开，也可能只是换了写法。未做任何修改',
  unmatched: (r) => `未能在当前版本定位补丁目标（${(r.missing ?? []).join(', ')}），未做任何修改`,
  blocked: (r) => `已阻止写入：${r.reason}。请先关闭该 fuse，或移除本插件`,
  failed: (r) => `自愈失败：${r.reason}`,
  skipped: (r) => `跳过：${r.reason ?? '未知原因'}`,
};

/**
 * 记录一次运行结果：状态文件 + 中文说明。
 * @param result - healArchive 的返回值。
 * @returns 中文说明。
 */
function reportResult(result) {
  const describe = STATUS_TEXT[result.status] ?? (() => String(result.status));
  const text = describe(result);
  writeLastRun(
    [
      `时间：${new Date().toISOString()}`,
      `结果：${result.status}`,
      `说明：${text}`,
      result.applied && result.applied.length > 0 ? `本次替换：${result.applied.join(', ')}` : '',
      result.missing && result.missing.length > 0 ? `未匹配：${result.missing.join(', ')}` : '',
      result.fuse ? `完整性校验：${FUSE_TEXT[result.fuse] ?? result.fuse}` : '',
    ].filter((line) => line !== ''),
  );
  return text;
}

function safeExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/**
 * Electron 的 `ELECTRON_RUN_AS_NODE` 进程把 `*.asar` 当目录，直接 open 会报
 * `ENOENT, not found in ...app.asar`。临时关闭 asar 支持后即可按普通文件读写。
 * @param fn - 在 noAsar 状态下执行的函数。
 */
function withNoAsar(fn) {
  const previous = process.noAsar;
  process.noAsar = true;
  try {
    return fn();
  } finally {
    process.noAsar = previous;
  }
}

/**
 * 分块扫描文件，返回 sentinel 的字节偏移；找不到返回 -1。
 * 分块是为了不把几百 MB 的可执行文件整个读进内存。
 * @param filePath - 待扫描文件。
 * @param sentinel - 要查找的字节串。
 */
function findSentinelOffset(filePath, sentinel) {
  const CHUNK = 4 * 1024 * 1024;
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const overlap = sentinel.length - 1;
    let carry = Buffer.alloc(0);
    let pos = 0;
    while (pos < size) {
      const len = Math.min(CHUNK, size - pos);
      const chunk = Buffer.alloc(len);
      fs.readSync(fd, chunk, 0, len, pos);
      const hay = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
      const at = hay.indexOf(sentinel);
      if (at >= 0) return pos - carry.length + at;
      carry = hay.subarray(Math.max(0, hay.length - overlap));
      pos += len;
    }
    return -1;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 读安装目录里 Electron 可执行文件的 fuse 状态，确认 asar 完整性校验是否开启。
 * 开启时改写 app.asar 会让应用启动失败，所以写之前必须先查。
 * @param asarPath - app.asar 路径。
 * @returns {{ state: 'enabled'|'disabled'|'removed'|'unknown', exe: string|null }}
 */
function readAsarIntegrityFuse(asarPath) {
  const installDir = path.dirname(path.dirname(asarPath));
  const candidates = [];

  try {
    if (typeof process.execPath === 'string' && process.execPath !== '') {
      candidates.push(process.execPath);
    }
  } catch {
    /* ignore */
  }

  try {
    for (const entry of fs.readdirSync(installDir)) {
      if (entry.toLowerCase().endsWith('.exe')) candidates.push(path.join(installDir, entry));
    }
  } catch {
    /* ignore */
  }

  for (const exe of candidates) {
    if (!withNoAsar(() => safeExists(exe))) continue;

    let offset;
    try {
      offset = findSentinelOffset(exe, FUSE_SENTINEL);
    } catch {
      continue;
    }
    if (offset < 0) continue;

    let wire;
    try {
      const fd = fs.openSync(exe, 'r');
      try {
        wire = Buffer.alloc(64);
        fs.readSync(fd, wire, 0, 64, offset);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      continue;
    }

    const wireVersion = wire[FUSE_SENTINEL.length];
    const count = wire[FUSE_SENTINEL.length + 1];
    if (wireVersion !== 1 || count <= FUSE_ASAR_INTEGRITY) continue;

    const state = FUSE_STATE[wire[FUSE_SENTINEL.length + 2 + FUSE_ASAR_INTEGRITY]];
    return { state: state ?? 'unknown', exe };
  }

  return { state: 'unknown', exe: null };
}

/**
 * 定位 app.asar。优先环境变量，其次 process.resourcesPath，再次从可执行文件推断，
 * 最后从命令行参数里找（覆盖开发 / 便携布局）。
 * @returns 存在的路径，或 null。
 */
function findAsar() {
  const candidates = [];
  const override = process.env[ASAR_ENV];
  if (override) candidates.push(override);

  if (typeof process.resourcesPath === 'string' && process.resourcesPath !== '') {
    candidates.push(path.join(process.resourcesPath, 'app.asar'));
  }

  try {
    candidates.push(path.join(path.dirname(process.execPath), 'resources', 'app.asar'));
  } catch {
    /* ignore */
  }

  for (const arg of process.argv) {
    if (typeof arg !== 'string') continue;
    const idx = arg.indexOf('app.asar');
    if (idx <= 0) continue;
    candidates.push(arg.slice(0, idx + 'app.asar'.length));
  }

  for (const candidate of candidates) {
    if (candidate && withNoAsar(() => safeExists(candidate))) return candidate;
  }
  return null;
}

function logger(ctx) {
  let sink;
  try {
    sink = typeof ctx?.logger === 'function' ? ctx.logger(name) : undefined;
  } catch {
    sink = undefined;
  }
  return (level, message) => {
    try {
      if (sink && typeof sink[level] === 'function') {
        sink[level](message);
        return;
      }
    } catch {
      /* fall through */
    }
    try {
      const line = `[${name}] ${message}`;
      if (level === 'warn') console.warn(line);
      else if (level === 'error') console.error(line);
      else console.log(line);
    } catch {
      /* never throw from logging */
    }
  };
}

/**
 * 读取归档头与 lib/main.js 的字节，做需要的替换，原地等长写回。
 * @param asarPath - app.asar 路径。
 * @returns 结果摘要。
 */
function healArchive(asarPath) {
  return withNoAsar(() => {
    let fd;
    try {
      fd = fs.openSync(asarPath, 'r+');
    } catch (error) {
      const code = error && typeof error === 'object' ? error.code : undefined;
      if (code === 'EACCES' || code === 'EPERM') {
        return {
          status: 'failed',
          reason: '没有写入权限（安装目录在 Program Files 下时以管理员身份启动一次即可修复）',
        };
      }
      if (code === 'EBUSY') {
        return { status: 'skipped', reason: 'app.asar 正被独占占用' };
      }
      throw error;
    }

    try {
      const sizeBuf = Buffer.alloc(8);
      fs.readSync(fd, sizeBuf, 0, 8, 0);
      const headerPickleSize = sizeBuf.readUInt32LE(4);
      if (headerPickleSize <= 0 || headerPickleSize > 64 * 1024 * 1024) {
        return { status: 'skipped', reason: 'not an asar archive' };
      }

      const headerBuf = Buffer.alloc(headerPickleSize);
      fs.readSync(fd, headerBuf, 0, headerPickleSize, 8);
      const jsonLength = headerBuf.readUInt32LE(4);
      const header = JSON.parse(headerBuf.toString('utf8', 8, 8 + jsonLength));

      let node = header;
      for (const segment of ENTRY_PATH.split('/')) {
        node = node?.files?.[segment];
        if (!node) return { status: 'skipped', reason: `${ENTRY_PATH} not found in archive` };
      }

      const base = 8 + headerPickleSize + Number(node.offset);
      const size = node.size;
      const raw = Buffer.alloc(size);
      fs.readSync(fd, raw, 0, size, base);

      const original = raw.toString('utf8');
      if (Buffer.byteLength(original, 'utf8') !== size) {
        return { status: 'skipped', reason: 'entry is not clean UTF-8' };
      }

      const done = RULES.filter((rule) => rule.isDone(original)).map((rule) => rule.id);
      const pending = [];
      const missing = [];
      for (const rule of RULES) {
        if (done.includes(rule.id)) continue;
        const hit = rule.locate(original);
        if (hit === null) missing.push(rule.id);
        else pending.push({ rule, hit });
      }

      if (pending.length === 0) {
        if (done.length === RULES.length) {
          return { status: 'intact', applied: [], missing: [] };
        }
        // 菜单项还在，但旧的开发模式判断已经不在了 —— 上游可能自己放开了，也可能只是换了写法。
        const ungatedUpstream = missing.includes('ungate') && original.includes('reloadPageMenu');
        return { status: ungatedUpstream ? 'upstream' : 'unmatched', applied: [], missing };
      }

      // 写之前先确认 asar 完整性校验没被打开，否则改完应用会起不来。
      const fuse = readAsarIntegrityFuse(asarPath);
      if (fuse.state === 'enabled') {
        return {
          status: 'blocked',
          reason:
            'asar 完整性校验（EnableEmbeddedAsarIntegrityValidation）处于启用状态，改写 app.asar 会导致应用无法启动',
          fuse: fuse.state,
          applied: [],
          missing: [],
        };
      }

      const applied = pending.map((item) => item.rule.id);
      let patched = original;
      // 从后往前替换，前面的下标就不会被后面的改动影响。
      for (const { hit } of [...pending].sort((a, b) => b.hit.start - a.hit.start)) {
        patched = patched.slice(0, hit.start) + hit.replacement + patched.slice(hit.end);
      }

      const out = Buffer.from(patched, 'utf8');
      if (out.length !== size) {
        return { status: 'skipped', reason: `length changed (${out.length} != ${size})` };
      }

      fs.writeSync(fd, out, 0, out.length, base);
      fs.fsyncSync(fd);

      const verify = Buffer.alloc(size);
      fs.readSync(fd, verify, 0, size, base);
      if (!verify.equals(out)) {
        return { status: 'failed', reason: 'read-back verification failed' };
      }

      return { status: 'healed', applied, fuse: fuse.state };
    } finally {
      fs.closeSync(fd);
    }
  });
}

/**
 * Host 插件入口。任何异常都只记录日志，绝不阻断 DSH 启动。
 * @param ctx - Host 插件上下文。
 */
export function apply(ctx) {
  const log = logger(ctx);

  try {
    const marker = disabledMarkerPath();
    if (marker && withNoAsar(() => safeExists(marker))) {
      writeLastRun([
        `时间：${new Date().toISOString()}`,
        '结果：disabled',
        '说明：已由用户标记为停用，本次未做任何检查',
      ]);
      log('info', '已由用户标记为停用，跳过自愈检查');
      return;
    }

    const asarPath = findAsar();
    if (asarPath === null) {
      writeLastRun([
        `时间：${new Date().toISOString()}`,
        '结果：no-asar',
        '说明：未找到 app.asar（非桌面版环境？），本次未做任何检查',
      ]);
      log('info', '未找到 app.asar（非桌面版环境？），跳过');
      return;
    }

    const result = healArchive(asarPath);
    reportResult(result);

    switch (result.status) {
      case 'healed':
        log(
          'warn',
          `检测到补丁已丢失，已自动修复（${result.applied.join(', ')}）。` +
            '请在下次启动 DeepSeek Harness 后查看「应用」菜单。',
        );
        break;
      case 'intact':
        log('info', '「应用」菜单补丁完好，无需处理');
        break;
      case 'upstream':
        log(
          'info',
          '没找到旧的开发模式判断，但菜单项还在 —— 上游可能已经自己放开，也可能只是换了写法。未做任何修改。',
        );
        break;
      case 'unmatched':
        log(
          'warn',
          `未能在当前版本中定位补丁目标（${(result.missing ?? []).join(', ')}）。` +
            '上游可能改了这段代码，未做任何修改。',
        );
        break;
      case 'blocked':
        log(
          'error',
          `已阻止写入：${result.reason}。` +
            '这种情况改写 app.asar 会让应用起不来，因此本次什么都没写。',
        );
        break;
      case 'failed':
        log('error', `自愈失败：${result.reason}`);
        break;
      default:
        log('warn', `跳过自愈：${result.reason ?? '未知原因'}`);
        break;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeLastRun([
      `时间：${new Date().toISOString()}`,
      '结果：error',
      `说明：自愈检查异常，已忽略：${message}`,
    ]);
    try {
      log('warn', `自愈检查异常，已忽略：${message}`);
    } catch {
      /* never throw from a boot-time plugin */
    }
  }
}
