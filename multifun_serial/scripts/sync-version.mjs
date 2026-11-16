// 版本号只有一个真相源：package.json 的 version。
// tauri.conf.json（MSI 的 ProductVersion / 安装包名 / 窗口标题 / 侧栏都读它）和
// Cargo.toml 都从这里同步——三处各写一份的结果就是 v2.0.2 时窗口还显示 v2.0.0。
// 由 npm 的 predev / prebuild / pretauri 钩子自动跑，也可以手动 `npm run sync:version`。
// 注意输出只用 ASCII：Windows 下 PowerShell / cmd 会按本地代码页解码 node 的 UTF-8 输出，
// 中文在终端里会变成乱码（注释不受影响，文件本身是 UTF-8）。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

// Tauri 侧对 version 有 semver 要求，写坏了会让 cargo build 失败，先挡一道
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`package.json version is not semver: ${version}`);
  process.exit(1);
}

let dirty = false;

const confPath = join(root, "src-tauri", "tauri.conf.json");
const conf = JSON.parse(readFileSync(confPath, "utf8"));
if (conf.version !== version) {
  console.log(`tauri.conf.json: ${conf.version} -> ${version}`);
  conf.version = version;
  writeFileSync(confPath, `${JSON.stringify(conf, null, 2)}\n`);
  dirty = true;
}

// Cargo.toml 只动 [package] 段那行 version，依赖里的 version 不能碰
const cargoPath = join(root, "src-tauri", "Cargo.toml");
const lines = readFileSync(cargoPath, "utf8").split("\n");
let inPackage = false;
let cargoDirty = false;
for (let i = 0; i < lines.length; i += 1) {
  if (lines[i].trim() === "[package]") {
    inPackage = true;
    continue;
  }
  if (!inPackage) continue;
  if (lines[i].startsWith("[")) break;
  const replaced = lines[i].replace(/^version = "[^"]*"/, `version = "${version}"`);
  if (replaced !== lines[i]) {
    console.log(`Cargo.toml: ${lines[i].trim()} -> version = "${version}"`);
    lines[i] = replaced;
    cargoDirty = true;
  }
}
if (cargoDirty) {
  writeFileSync(cargoPath, lines.join("\n"));
  dirty = true;
}

if (!dirty) console.log(`version up to date: ${version}`);
