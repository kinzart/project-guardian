// File inventory of a project folder for the Cérebro notes: what is inside (every file, by type),
// how big it is, and which images can be previewed. Only names, sizes and dates are read;
// no file is opened, so it is safe on Google Drive folders too.
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export const FILE_TYPES = [
  ['video', 'Vídeo', 'mp4 mov mkv avi wmv webm m4v mpg mpeg flv 3gp mts m2ts vob prproj veg'],
  ['audio', 'Áudio', 'wav mp3 flac aif aiff ogg m4a aac wma opus mid midi'],
  ['musica', 'Projeto de música', 'flp als alp song ptx ptf logicx cpr npr rpp bwproject reason sng mmp mmpz'],
  ['imagem', 'Imagem', 'jpg jpeg png gif webp bmp tif tiff heic heif raw cr2 cr3 nef arw dng ico avif'],
  ['design', 'Design', 'psd psb ai indd fig xd sketch afdesign afphoto cdr eps svg kra xcf aep drp capcut'],
  ['documento', 'Documento', 'pdf doc docx odt rtf txt md pages epub'],
  ['planilha', 'Planilha', 'xls xlsx xlsm xlr ods csv tsv numbers'],
  ['apresentacao', 'Apresentação', 'ppt pptx odp key'],
  ['codigo', 'Código', 'js mjs cjs ts tsx jsx py rb go rs java kt c cpp h cs php html css scss json yaml yml toml xml sh ps1 bat cmd sql ipynb vue svelte lua dart swift'],
  ['compactado', 'Compactado', 'zip rar 7z tar gz tgz bz2 xz iso dmg'],
  ['programa', 'Programa', 'exe msi apk appx dll'],
  ['3d', '3D', 'blend fbx obj stl glb gltf max c4d ma mb usdz'],
  ['fonte', 'Fonte', 'ttf otf woff woff2'],
];
const TYPE_BY_EXT = new Map();
for (const [key, , exts] of FILE_TYPES) for (const e of exts.split(' ')) TYPE_BY_EXT.set(e, key);
export const TYPE_LABEL = Object.fromEntries([...FILE_TYPES.map(([k, l]) => [k, l]), ['outro', 'Outros']]);
export const PREVIEWABLE = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'svg']);

// Folders that are machine-made and would drown the listing.
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.cache', '.next', '.nuxt', '.turbo', '.pytest_cache', '.mypy_cache', '.parcel-cache', '.gradle', '$recycle.bin', 'system volume information']);

export function typeOf(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  return { ext, type: TYPE_BY_EXT.get(ext) || 'outro' };
}

export function formatSize(b) {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1).replace('.', ',')} GB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1).replace('.', ',')} MB`;
  return `${Math.max(1, Math.ceil(b / 1024))} KB`;
}

// Walks `root` (depth-first, no symlinks). Returns null when the folder can't be read.
export function inventoryFolder(root, { maxFiles = 20000, skip = [] } = {}) {
  const skipDirs = new Set([...SKIP_DIRS, ...skip.map((s) => String(s).toLowerCase())]);
  const inv = { root, files: [], total: 0, bytes: 0, truncated: false, skipped: [], byType: new Map(), folders: new Map() };
  try { readdirSync(root); } catch { return null; }
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    let entries;
    try { entries = readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const childRel = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) {
        if (skipDirs.has(e.name.toLowerCase())) { inv.skipped.push(childRel); continue; }
        stack.push(childRel);
        continue;
      }
      if (!e.isFile()) continue;
      inv.total += 1;
      if (inv.files.length >= maxFiles) { inv.truncated = true; continue; }
      let st; try { st = statSync(path.join(root, childRel)); } catch { continue; }
      const { ext, type } = typeOf(e.name);
      const f = { rel: childRel, name: e.name, ext, type, size: st.size, mtime: st.mtime.toISOString() };
      inv.files.push(f);
      inv.bytes += st.size;
      const t = inv.byType.get(type) || { count: 0, bytes: 0, exts: new Map() };
      t.count += 1; t.bytes += st.size; t.exts.set(ext || '(sem)', (t.exts.get(ext || '(sem)') || 0) + 1);
      inv.byType.set(type, t);
      const top = childRel.includes(path.sep) ? childRel.split(path.sep)[0] : '';
      const fo = inv.folders.get(top) || { count: 0, bytes: 0, types: new Set() };
      fo.count += 1; fo.bytes += st.size; fo.types.add(type);
      inv.folders.set(top, fo);
    }
  }
  inv.files.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return inv;
}

export function typesPresent(inv) {
  return inv ? [...inv.byType.entries()].sort((a, b) => b[1].count - a[1].count).map(([k]) => k) : [];
}
