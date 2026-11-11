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

/**
 * 全部替换项。old / new 的 UTF-8 字节数必须严格相等，
 * 这样原地写入后文件长度不变。
 */
const REPLACEMENTS = [
  {
    id: 'ungate',
    old: '...development ? [',
    new: '...true ? /*   */[',
  },
  {
    id: 'rename-zh',
    old: 'restartAppHostMenu: "\u91cd\u542f\u5e94\u7528\u4e0e Host",',
    new: 'restartAppHostMenu:         "\u91cd\u542f\u5e94\u7528",',
  },
  {
    id: 'rename-en',
    old: 'restartAppHostMenu: "Restart App and Host",',
    new: 'restartAppHostMenu:          "Restart App",',
  },
];

/** 替换表自检：任何一条不等长都直接拒绝加载，绝不写坏归档。 */
for (const rule of REPLACEMENTS) {
  if (Buffer.byteLength(rule.old, 'utf8') !== Buffer.byteLength(rule.new, 'utf8')) {
    throw new Error(`dsh-desktop-menu-heal: replacement "${rule.id}" is not byte-length neutral`);
  }
}

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
  upstream: () => '上游已经自己放开了这两项菜单（旧的开发模式判断已不存在），本插件不再需要，可以移除',
  unmatched: (r) => `未能在当前版本定位补丁目标（${(r.missing ?? []).join(', ')}），未做任何修改`,
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

      const alreadyDone = REPLACEMENTS.filter((rule) => original.includes(rule.new)).map((rule) => rule.id);
      const todo = REPLACEMENTS.filter((rule) => !original.includes(rule.new) && original.includes(rule.old));
      const missing = REPLACEMENTS.filter((rule) => !original.includes(rule.new) && !original.includes(rule.old)).map((rule) => rule.id);

      if (todo.length === 0) {
        if (alreadyDone.length === REPLACEMENTS.length) {
          return { status: 'intact', applied: [], missing: [] };
        }
        // 菜单项还在，但旧的开发模式判断已经不在了 —— 说明上游自己放开了这两项。
        const ungatedUpstream = missing.includes('ungate') && original.includes('reloadPageMenu');
        return { status: ungatedUpstream ? 'upstream' : 'unmatched', applied: [], missing };
      }

      let patched = original;
      const applied = [];
      for (const rule of todo) {
        const at = patched.indexOf(rule.old);
        if (at < 0) continue;
        patched = patched.slice(0, at) + rule.new + patched.slice(at + rule.old.length);
        applied.push(rule.id);
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

      return { status: 'healed', applied };
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
          '上游已经自己放开了这两项菜单（旧的开发模式判断已不存在），本插件不再需要，可以移除此插件。',
        );
        break;
      case 'unmatched':
        log(
          'warn',
          `未能在当前版本中定位补丁目标（${(result.missing ?? []).join(', ')}）。` +
            '上游可能改了这段代码，未做任何修改。',
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
