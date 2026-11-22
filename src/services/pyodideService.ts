// Pyodide WASM Client-Side Python Runner & Persistent Pip Manager

declare global {
  interface Window {
    loadPyodide?: (config: { indexURL: string }) => Promise<any>;
    pyodideInstance?: any;
    __pydroid_input_callback?: (promptText: string) => string | null;
    __pydroid_tty_stdout?: (chunk: string) => void;
    __pydroid_tty_stderr?: (chunk: string) => void;
    __pydroid_cancel_requested?: boolean;
  }
}

export interface PersistedPipEntry {
  name: string;
  source: 'pyodide' | 'micropip' | 'cpython';
  installedAt: string;
}

const PIP_STORAGE_KEY = 'pydroid_pip_packages';
const IDB_NAME = 'pydroid_pip_cache_db';
const IDB_STORE = 'site_packages';
const IDB_VERSION = 1;

export const BUILTIN_STDLIB_PACKAGES = [
  'builtins',
  'math',
  'sys',
  'os',
  'random',
  'time',
  'json',
  'datetime',
  're',
] as const;

const BUILTIN_SET = new Set<string>(BUILTIN_STDLIB_PACKAGES);

// Map common Python import names to pip/Pyodide package names
const IMPORT_TO_PACKAGE_MAP: Record<string, string> = {
  numpy: 'numpy',
  matplotlib: 'matplotlib',
  pandas: 'pandas',
  scipy: 'scipy',
  sympy: 'sympy',
  PIL: 'pillow',
  pillow: 'pillow',
  bs4: 'beautifulsoup4',
  beautifulsoup4: 'beautifulsoup4',
  pyfiglet: 'pyfiglet',
  colorama: 'colorama',
  requests: 'requests',
  rich: 'rich',
  yaml: 'pyyaml',
  pyyaml: 'pyyaml',
  sklearn: 'scikit-learn',
};

const PYODIDE_PREBUILT_PACKAGES = new Set<string>([
  'numpy',
  'matplotlib',
  'pandas',
  'scipy',
  'sympy',
  'pillow',
  'scikit-learn',
  'pyyaml',
  'beautifulsoup4',
  'micropip',
]);

let pyodideLoadingPromise: Promise<any> | null = null;
let runtimeBootstrapped = false;
let micropipLoaded = false;
let sitePackagesRestored = false;

// --- LocalStorage Registry for Installed Packages (survives APK & browser restarts) ---

export function getSavedUserPipPackages(): PersistedPipEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(PIP_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    const normalized: PersistedPipEntry[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      if (typeof item === 'string') {
        const clean = item.trim().toLowerCase();
        if (clean && !BUILTIN_SET.has(clean) && !seen.has(clean)) {
          seen.add(clean);
          normalized.push({
            name: clean,
            source: 'micropip',
            installedAt: new Date().toISOString(),
          });
        }
      } else if (item && typeof item.name === 'string') {
        const clean = item.name.trim().toLowerCase();
        if (clean && !BUILTIN_SET.has(clean) && !seen.has(clean)) {
          seen.add(clean);
          normalized.push({
            name: clean,
            source:
              item.source === 'pyodide' || item.source === 'cpython' ? item.source : 'micropip',
            installedAt: item.installedAt || new Date().toISOString(),
          });
        }
      }
    }
    return normalized;
  } catch {
    return [];
  }
}

export function saveUserPipPackage(
  packageName: string,
  source: 'pyodide' | 'micropip' | 'cpython' = 'micropip'
): PersistedPipEntry[] {
  if (typeof window === 'undefined') return [];
  const clean = normalizePackageName(packageName);
  if (!clean || BUILTIN_SET.has(clean)) return getSavedUserPipPackages();

  const existing = getSavedUserPipPackages().filter((p) => p.name !== clean);
  const next: PersistedPipEntry[] = [
    ...existing,
    {
      name: clean,
      source,
      installedAt: new Date().toISOString(),
    },
  ];
  try {
    localStorage.setItem(PIP_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore storage quota errors
  }
  return next;
}

export function mergeSavedPipPackages(
  packageNames: string[],
  source: 'pyodide' | 'micropip' | 'cpython' = 'cpython'
): PersistedPipEntry[] {
  if (typeof window === 'undefined') return [];
  const existing = getSavedUserPipPackages();
  const map = new Map<string, PersistedPipEntry>(existing.map((e) => [e.name, e]));
  let changed = false;

  for (const raw of packageNames) {
    const clean = normalizePackageName(raw);
    if (!clean || BUILTIN_SET.has(clean)) continue;
    if (!map.has(clean)) {
      map.set(clean, {
        name: clean,
        source,
        installedAt: new Date().toISOString(),
      });
      changed = true;
    }
  }

  const next = Array.from(map.values());
  if (changed) {
    try {
      localStorage.setItem(PIP_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  }
  return next;
}

export async function removeUserPipPackage(packageName: string): Promise<PersistedPipEntry[]> {
  const clean = normalizePackageName(packageName);
  const next = getSavedUserPipPackages().filter((p) => p.name !== clean);
  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem(PIP_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  }

  // Also clear cached pure-Python site-packages snapshot if removing custom packages
  if (next.length === 0) {
    await clearSitePackagesCache().catch(() => {});
  } else if (window.pyodideInstance) {
    // Re-snapshot is complex without clean state; remove matching top-level entries from IDB snapshot
    await removeMatchingCachedEntries(clean).catch(() => {});
  }
  return next;
}

export function normalizePackageName(raw: string): string {
  // Strip version specifiers like requests==2.31.0 or rich>=13
  return raw
    .trim()
    .split(/[=<>!~\[]/)[0]
    .trim()
    .toLowerCase();
}

export function getInstalledPackagesList(): string[] {
  const saved = getSavedUserPipPackages().map((p) => p.name);
  return Array.from(new Set([...BUILTIN_STDLIB_PACKAGES, ...saved]));
}

export function getUserInstalledPackageNames(): string[] {
  return getSavedUserPipPackages().map((p) => p.name);
}

// --- IndexedDB Site-Packages Cache (Offline Persistence for Micropip Packages on APK) ---

interface CachedFileEntry {
  path: string;
  data: Uint8Array;
}

function openPipDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: 'path' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
  });
}

async function saveSitePackageFilesToIDB(entries: CachedFileEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const db = await openPipDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const store = tx.objectStore(IDB_STORE);
    for (const entry of entries) {
      store.put(entry);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function loadAllSitePackageFilesFromIDB(): Promise<CachedFileEntry[]> {
  const db = await openPipDB();
  const rows = await new Promise<CachedFileEntry[]>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const store = tx.objectStore(IDB_STORE);
    const req = store.getAll();
    req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return rows;
}

async function clearSitePackagesCache(): Promise<void> {
  const db = await openPipDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function removeMatchingCachedEntries(pkgName: string): Promise<void> {
  const rows = await loadAllSitePackageFilesFromIDB();
  if (rows.length === 0) return;
  const normalizedPkg = pkgName.replace(/-/g, '_');
  const db = await openPipDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const store = tx.objectStore(IDB_STORE);
    for (const row of rows) {
      const lower = row.path.toLowerCase();
      if (lower.includes(`/${pkgName}`) || lower.includes(`/${normalizedPkg}`)) {
        store.delete(row.path);
      }
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

function getSitePackagesRoot(pyodide: any): string {
  try {
    const dir = pyodide.runPython('import site; site.getsitepackages()[0]');
    if (typeof dir === 'string' && dir) return dir;
  } catch {
    // fallback
  }
  return '/lib/python3.12/site-packages';
}

function collectFilesRecursive(FS: any, dirPath: string, out: Set<string>) {
  try {
    const names: string[] = FS.readdir(dirPath);
    for (const name of names) {
      if (name === '.' || name === '..' || name === '__pycache__') continue;
      const full = `${dirPath}/${name}`;
      try {
        const stat = FS.stat(full);
        if (FS.isDir(stat.mode)) {
          collectFilesRecursive(FS, full, out);
        } else if (FS.isFile(stat.mode)) {
          out.add(full);
        }
      } catch {
        // ignore stat errors
      }
    }
  } catch {
    // ignore missing dir
  }
}

function ensureDirRecursive(FS: any, dirPath: string) {
  const parts = dirPath.split('/').filter(Boolean);
  let cur = '';
  for (const part of parts) {
    cur += `/${part}`;
    try {
      FS.stat(cur);
    } catch {
      try {
        FS.mkdir(cur);
      } catch {
        // ignore if already exists
      }
    }
  }
}

async function restoreCachedSitePackages(pyodide: any): Promise<void> {
  if (sitePackagesRestored) return;
  sitePackagesRestored = true;
  try {
    const entries = await loadAllSitePackageFilesFromIDB();
    if (!entries || entries.length === 0) return;

    const FS = pyodide.FS;
    for (const entry of entries) {
      const lastSlash = entry.path.lastIndexOf('/');
      if (lastSlash > 0) {
        ensureDirRecursive(FS, entry.path.slice(0, lastSlash));
      }
      const bytes = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
      FS.writeFile(entry.path, bytes);
    }
    try {
      pyodide.runPython('import importlib; importlib.invalidate_caches()');
    } catch {
      // ignore
    }
  } catch (err) {
    console.warn('Could not restore cached site-packages from IndexedDB:', err);
  }
}

// --- Core One-Time Pyodide Boot & Runtime Setup ---

const CORE_BOOTSTRAP_SCRIPT = `
import sys
import io
import os
import builtins
import json
import ast
from js import window

class _PydroidWaitingInput(Exception):
    """Raised to yield execution back to JS runtime when input queue is empty"""
    def __init__(self, prompt=""):
        self.prompt = prompt
        super().__init__(prompt)

_pydroid_input_queue = []
_pydroid_stdout_buffer = []
_pydroid_stderr_buffer = []
_pydroid_last_prompt = ""
_pydroid_is_waiting_input = False
_pydroid_echo_enabled = True

class _PydroidTTYStream:
    encoding = 'utf-8'
    errors = 'replace'

    def __init__(self, stream_type='stdout'):
        self.stream_type = stream_type

    def write(self, s):
        if s is None:
            return 0
        text = str(s)
        if not text:
            return 0
        buf = _pydroid_stdout_buffer if self.stream_type == 'stdout' else _pydroid_stderr_buffer
        buf.append(text)
        try:
            cb_name = '__pydroid_tty_stdout' if self.stream_type == 'stdout' else '__pydroid_tty_stderr'
            cb = getattr(window, cb_name, None)
            if cb is not None:
                cb(text)
        except Exception:
            pass
        return len(text)

    def flush(self):
        pass

    def isatty(self):
        return True

    def readable(self):
        return False

    def writable(self):
        return True

    def seekable(self):
        return False

    def fileno(self):
        return 1 if self.stream_type == 'stdout' else 2

class _PydroidTTYStdin:
    encoding = 'utf-8'
    errors = 'replace'

    def isatty(self):
        return True

    def readable(self):
        return True

    def writable(self):
        return False

    def seekable(self):
        return False

    def fileno(self):
        return 0

    def readline(self, size=-1):
        global _pydroid_is_waiting_input, _pydroid_last_prompt
        if len(_pydroid_input_queue) > 0:
            val = str(_pydroid_input_queue.pop(0))
            if _pydroid_echo_enabled:
                sys.stdout.write(val + "\\n")
            return val + "\\n"

        _pydroid_is_waiting_input = True
        raise _PydroidWaitingInput(_pydroid_last_prompt or "")

    def read(self, size=-1):
        if size is None or size < 0:
            chunks = []
            while len(_pydroid_input_queue) > 0:
                chunks.append(self.readline())
            return "".join(chunks)
        res = self.readline()
        return res[:size] if len(res) > size else res

    def readlines(self, hint=-1):
        lines = []
        while len(_pydroid_input_queue) > 0:
            lines.append(self.readline())
        return lines

    def __iter__(self):
        return self

    def __next__(self):
        if len(_pydroid_input_queue) > 0:
            return self.readline()
        raise StopIteration

sys.stdout = _PydroidTTYStream('stdout')
sys.stderr = _PydroidTTYStream('stderr')
sys.stdin = _PydroidTTYStdin()

def _custom_input(prompt=""):
    global _pydroid_last_prompt, _pydroid_is_waiting_input
    p_str = str(prompt) if prompt is not None else ""
    _pydroid_last_prompt = p_str
    if p_str:
        sys.stdout.write(p_str)

    if len(_pydroid_input_queue) > 0:
        val = str(_pydroid_input_queue.pop(0))
        if _pydroid_echo_enabled:
            sys.stdout.write(val + "\\n")
        return val

    _pydroid_is_waiting_input = True
    raise _PydroidWaitingInput(_pydroid_last_prompt)

builtins.input = _custom_input

def _pydroid_reset_io(inputs_json):
    global _pydroid_input_queue, _pydroid_stdout_buffer, _pydroid_stderr_buffer
    global _pydroid_last_prompt, _pydroid_is_waiting_input
    _pydroid_input_queue = json.loads(inputs_json)
    _pydroid_stdout_buffer = []
    _pydroid_stderr_buffer = []
    _pydroid_last_prompt = ""
    _pydroid_is_waiting_input = False

def _pydroid_transform_sleep(src):
    try:
        tree = ast.parse(src)
        has_asyncio = False
        has_sleep_calls = False
        for node in tree.body:
            if isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name == 'asyncio':
                        has_asyncio = True

        class _SleepToAwait(ast.NodeTransformer):
            def __init__(self):
                self.in_sync_func = False
            def visit_FunctionDef(self, node):
                old = self.in_sync_func
                self.in_sync_func = True
                self.generic_visit(node)
                self.in_sync_func = old
                return node
            def visit_AsyncFunctionDef(self, node):
                old = self.in_sync_func
                self.in_sync_func = True
                self.generic_visit(node)
                self.in_sync_func = old
                return node
            def visit_Call(self, node):
                nonlocal has_sleep_calls
                self.generic_visit(node)
                if self.in_sync_func:
                    return node
                is_sleep = False
                if isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name) and node.func.value.id == 'time' and node.func.attr == 'sleep':
                    is_sleep = True
                elif isinstance(node.func, ast.Name) and node.func.id == 'sleep':
                    is_sleep = True
                if is_sleep:
                    has_sleep_calls = True
                    return ast.Await(
                        value=ast.Call(
                            func=ast.Attribute(
                                value=ast.Name(id='asyncio', ctx=ast.Load()),
                                attr='sleep',
                                ctx=ast.Load()
                            ),
                            args=node.args,
                            keywords=node.keywords
                        )
                    )
                return node

        new_tree = _SleepToAwait().visit(tree)
        if has_sleep_calls:
            if not has_asyncio:
                new_tree.body.insert(0, ast.Import(names=[ast.alias(name='asyncio', asname=None)]))
            ast.fix_missing_locations(new_tree)
            return ast.unparse(new_tree)
        return src
    except Exception:
        return src
`;

export type PyodideStatus = 'unloaded' | 'loading' | 'ready' | 'running' | 'error';

export interface PyodideRunOptions {
  code: string;
  inputs?: string[];
  signal?: AbortSignal;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
  onStatus?: (message: string) => void;
  onInputPrompt?: (promptText: string) => Promise<string>;
}

async function ensureMicropipLoaded(pyodide: any, onProgress?: (msg: string) => void) {
  if (micropipLoaded) return;
  onProgress?.('Đang nạp trình cài đặt micropip...');
  await pyodide.loadPackage('micropip');
  micropipLoaded = true;
}

export async function getPyodideInstance(onProgress?: (message: string) => void): Promise<any> {
  if (window.pyodideInstance) {
    if (!sitePackagesRestored) {
      await restoreCachedSitePackages(window.pyodideInstance);
    }
    return window.pyodideInstance;
  }

  if (pyodideLoadingPromise) {
    return pyodideLoadingPromise;
  }

  pyodideLoadingPromise = (async () => {
    try {
      onProgress?.('Đang tải nhân Python 3.12 WebAssembly...');

      if (!window.loadPyodide) {
        await new Promise<void>((resolve, reject) => {
          const existing = document.querySelector<HTMLScriptElement>(
            'script[data-pydroid-pyodide="true"]'
          );
          if (existing) {
            existing.addEventListener('load', () => resolve(), { once: true });
            existing.addEventListener(
              'error',
              () => reject(new Error('Không thể tải Pyodide từ CDN. Vui lòng kiểm tra kết nối mạng.')),
              { once: true }
            );
            return;
          }
          const script = document.createElement('script');
          script.src = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js';
          script.async = true;
          script.setAttribute('data-pydroid-pyodide', 'true');
          script.onload = () => resolve();
          script.onerror = () =>
            reject(new Error('Không thể tải Pyodide từ CDN. Vui lòng kiểm tra kết nối mạng.'));
          document.head.appendChild(script);
        });
      }

      onProgress?.('Khởi tạo môi trường Python 3.12...');
      const pyodide = await window.loadPyodide!({
        indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/',
      });

      if (!runtimeBootstrapped) {
        await pyodide.runPythonAsync(CORE_BOOTSTRAP_SCRIPT);
        runtimeBootstrapped = true;
      }

      await restoreCachedSitePackages(pyodide);

      window.pyodideInstance = pyodide;
      return pyodide;
    } catch (err) {
      pyodideLoadingPromise = null;
      throw err;
    }
  })();

  return pyodideLoadingPromise;
}

// Silently warm up Pyodide in background so first RUN feels instantaneous
export function prewarmPyodide(): void {
  if (typeof window === 'undefined') return;
  if (window.pyodideInstance || pyodideLoadingPromise) return;
  void getPyodideInstance().catch(() => {
    // Silent background warmup; errors surface when user explicitly runs code
  });
}

function isPyodidePackageLoaded(pyodide: any, pkgName: string): boolean {
  try {
    const loaded = pyodide.loadedPackages || {};
    return !!loaded[pkgName] || !!loaded[pkgName.toLowerCase()];
  } catch {
    return false;
  }
}

export async function installPyodidePackage(
  packageName: string,
  onProgress?: (msg: string) => void
): Promise<boolean> {
  const trimmed = packageName.trim();
  const normalized = normalizePackageName(trimmed);
  if (!normalized) {
    throw new Error('Tên thư viện không hợp lệ.');
  }

  const pyodide = await getPyodideInstance(onProgress);
  onProgress?.(`Đang tải và cài đặt ${trimmed}...`);

  try {
    if (PYODIDE_PREBUILT_PACKAGES.has(normalized)) {
      await pyodide.loadPackage(normalized);
      saveUserPipPackage(normalized, 'pyodide');
      return true;
    }

    // Try built-in Pyodide package first in case it's in Pyodide repodata
    try {
      await pyodide.loadPackage(normalized);
      saveUserPipPackage(normalized, 'pyodide');
      return true;
    } catch {
      // Fall back to micropip + snapshot pure-Python site-packages into IndexedDB
      await ensureMicropipLoaded(pyodide, onProgress);
      const siteDir = getSitePackagesRoot(pyodide);
      const FS = pyodide.FS;
      const beforeFiles = new Set<string>();
      collectFilesRecursive(FS, siteDir, beforeFiles);

      const micropip = pyodide.pyimport('micropip');
      await micropip.install(trimmed);

      const afterFiles = new Set<string>();
      collectFilesRecursive(FS, siteDir, afterFiles);

      const addedEntries: CachedFileEntry[] = [];
      for (const filePath of afterFiles) {
        if (!beforeFiles.has(filePath)) {
          try {
            const bytes: Uint8Array = FS.readFile(filePath, { encoding: 'binary' });
            addedEntries.push({
              path: filePath,
              data: new Uint8Array(bytes),
            });
          } catch {
            // ignore unreadable file
          }
        }
      }

      if (addedEntries.length > 0) {
        onProgress?.(`Đang lưu ${normalized} vào bộ nhớ thiết bị...`);
        await saveSitePackageFilesToIDB(addedEntries).catch(() => {});
      }

      saveUserPipPackage(normalized, 'micropip');
      return true;
    }
  } catch (err: any) {
    console.error(`Lỗi cài đặt ${trimmed}:`, err);
    throw new Error(`Không thể cài đặt ${trimmed}: ${err?.message || err}`);
  }
}

// Scan Python imports in code and ensure required prebuilt / persisted packages are loaded
async function ensureCodePackagesReady(
  pyodide: any,
  code: string,
  onStatus?: (msg: string) => void
): Promise<void> {
  const importedModules = new Set<string>();
  const importRegex = /^\s*(?:import|from)\s+([a-zA-Z0-9_]+)/gm;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(code)) !== null) {
    if (match[1]) importedModules.add(match[1]);
  }

  if (importedModules.size === 0) return;

  const savedEntries = getSavedUserPipPackages();
  const savedMap = new Map(savedEntries.map((e) => [e.name, e]));

  const packagesToLoad = new Set<string>();
  for (const mod of importedModules) {
    const mapped = IMPORT_TO_PACKAGE_MAP[mod] || IMPORT_TO_PACKAGE_MAP[mod.toLowerCase()];
    if (mapped && PYODIDE_PREBUILT_PACKAGES.has(mapped) && !isPyodidePackageLoaded(pyodide, mapped)) {
      packagesToLoad.add(mapped);
      continue;
    }

    const modLower = mod.toLowerCase();
    const modDash = modLower.replace(/_/g, '-');
    const saved = savedMap.get(modLower) || savedMap.get(modDash) || (mapped ? savedMap.get(mapped) : undefined);
    if (saved && !isPyodidePackageLoaded(pyodide, saved.name)) {
      // Check if Python can already import it (from restored IndexedDB site-packages)
      let alreadyImportable = false;
      try {
        alreadyImportable = !!pyodide.runPython(
          `import importlib.util; importlib.util.find_spec(${JSON.stringify(mod)}) is not None`
        );
      } catch {
        alreadyImportable = false;
      }
      if (!alreadyImportable) {
        packagesToLoad.add(saved.name);
      }
    }
  }

  for (const pkg of packagesToLoad) {
    onStatus?.(`Đang nạp thư viện ${pkg}...`);
    try {
      if (PYODIDE_PREBUILT_PACKAGES.has(pkg)) {
        await pyodide.loadPackage(pkg);
      } else {
        await installPyodidePackage(pkg, onStatus);
      }
    } catch (err) {
      console.warn(`Auto-load skipped for ${pkg}:`, err);
    }
  }
}

export async function runPyodideCode(options: PyodideRunOptions): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  duration: number;
  engine: string;
  plotImages: string[];
  isWaitingInput?: boolean;
  prompt?: string;
}> {
  const { code, inputs = [], signal, onStdout, onStderr, onStatus } = options;
  const pyodide = await getPyodideInstance(onStatus);

  if (signal?.aborted) {
    throw new DOMException('Đã dừng thực thi.', 'AbortError');
  }

  // Ensure runtime helpers exist once
  if (!runtimeBootstrapped) {
    await pyodide.runPythonAsync(CORE_BOOTSTRAP_SCRIPT);
    runtimeBootstrapped = true;
  }

  // Normalize multi-line buffered inputs into sequential line queue
  const normalizedInputs: string[] = [];
  for (const item of inputs) {
    if (typeof item === 'string') {
      const lines = item.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
      normalizedInputs.push(...lines);
    } else if (item !== undefined && item !== null) {
      normalizedInputs.push(String(item));
    }
  }

  let stdoutBuffer = '';
  let stderrBuffer = '';

  // Real-time bidirectional streaming bridge for TTY echo and live output
  window.__pydroid_tty_stdout = (chunk: string) => {
    stdoutBuffer += chunk;
    onStdout?.(chunk);
  };

  window.__pydroid_tty_stderr = (chunk: string) => {
    stderrBuffer += chunk;
    onStderr?.(chunk);
  };

  // Configure Emscripten-level standard I/O streams
  let emscriptenInputIdx = 0;
  pyodide.setStdin({
    isatty: true,
    stdin: () => {
      if (emscriptenInputIdx < normalizedInputs.length) {
        return normalizedInputs[emscriptenInputIdx++];
      }
      return null;
    },
  });

  const startTime = performance.now();
  let exitCode = 0;
  let plotImages: string[] = [];

  try {
    // Fast per-run state reset (microseconds instead of re-parsing 200+ lines)
    pyodide.runPython(`_pydroid_reset_io(${JSON.stringify(JSON.stringify(normalizedInputs))})`);

    // Ensure any imported built-in or persisted pip packages are loaded cleanly
    await ensureCodePackagesReady(pyodide, code, onStatus);

    if (signal?.aborted) {
      throw new DOMException('Đã dừng thực thi.', 'AbortError');
    }

    // Configure non-interactive Agg backend + non-blocking plt.show() when matplotlib is referenced
    if (code.includes('matplotlib') || code.includes('plt')) {
      try {
        await pyodide.runPythonAsync(`
try:
    import matplotlib
    matplotlib.use("module://matplotlib.backends.backend_agg")
    import matplotlib.pyplot as plt
    plt.show = lambda *args, **kwargs: None
except Exception:
    pass
`);
      } catch {
        // ignore if matplotlib fails to init
      }
    }

    // Transform top-level time.sleep to non-blocking asyncio.sleep if code contains sleep
    let runnableCode = code;
    if (code.includes('sleep')) {
      try {
        const transformed = pyodide.runPython(`_pydroid_transform_sleep(${JSON.stringify(code)})`);
        if (transformed && typeof transformed === 'string') {
          runnableCode = transformed;
        }
      } catch {
        runnableCode = code;
      }
    }

    // Execute user code in a fresh isolated module namespace so variables don't leak between runs
    const execNamespace = pyodide.toPy({ __name__: '__main__', __file__: 'main.py' });
    try {
      await pyodide.runPythonAsync(runnableCode, { globals: execNamespace });
    } finally {
      execNamespace.destroy?.();
    }

    // Check for rendered matplotlib plots only if matplotlib was loaded
    if (code.includes('matplotlib') || code.includes('plt.')) {
      const plotCaptureScript = `
import sys, json
_captured_plots = []
if 'matplotlib.pyplot' in sys.modules:
    try:
        import matplotlib.pyplot as plt
        import io, base64
        for fig_num in plt.get_fignums():
            fig = plt.figure(fig_num)
            buf = io.BytesIO()
            fig.savefig(buf, format='png', bbox_inches='tight', dpi=120)
            buf.seek(0)
            _captured_plots.append(base64.b64encode(buf.read()).decode('utf-8'))
            plt.close(fig)
    except Exception:
        pass
json.dumps(_captured_plots)
`;
      const plotsJson = await pyodide.runPythonAsync(plotCaptureScript);
      try {
        plotImages = JSON.parse(plotsJson);
      } catch {
        plotImages = [];
      }
    }
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      exitCode = 130;
      const cancelMsg = 'Đã dừng thực thi bởi người dùng.';
      stderrBuffer += (stderrBuffer ? '\n' : '') + cancelMsg;
      onStderr?.(cancelMsg);
      return {
        stdout: stdoutBuffer,
        stderr: stderrBuffer,
        exitCode,
        duration: Math.round(performance.now() - startTime),
        engine: 'Pyodide 0.26.4 (WASM TTY Emulated)',
        plotImages,
        isWaitingInput: false,
      };
    }

    // Check with Python runtime directly if process yielded for interactive input
    let isWaitingFromPython = false;
    let pyStdout = '';
    let pyPrompt = '';
    try {
      isWaitingFromPython = !!pyodide.runPython('_pydroid_is_waiting_input');
      pyStdout = pyodide.runPython('"".join(_pydroid_stdout_buffer)');
      pyPrompt = pyodide.runPython('_pydroid_last_prompt');
    } catch {
      // ignore
    }

    const errStr = String(err?.message || err || '');
    const errType = String(err?.type || '');
    const isWaiting =
      isWaitingFromPython ||
      errType === '_PydroidWaitingInput' ||
      errType === 'EOFError' ||
      errStr.includes('_PydroidWaitingInput') ||
      errStr.includes('EOFError') ||
      errStr.includes('EOF when reading a line');

    if (isWaiting) {
      return {
        stdout: pyStdout || stdoutBuffer,
        stderr: '',
        exitCode: 0,
        duration: Math.round(performance.now() - startTime),
        engine: 'Pyodide 0.26.4 (WASM TTY Emulated)',
        plotImages,
        isWaitingInput: true,
        prompt: pyPrompt || 'input():',
      };
    }

    // Actual runtime or syntax error
    exitCode = 1;
    let cleanErr = errStr;
    if (cleanErr === 'PythonError') {
      try {
        cleanErr = pyodide.runPython('"".join(_pydroid_stderr_buffer)') || errStr;
      } catch {
        // ignore
      }
    }

    // Clean up internal Pyodide runtime frames to present a clean, native Python traceback
    const errLines = cleanErr.split('\n');
    const filteredLines: string[] = [];
    let skippingInternal = false;
    for (const line of errLines) {
      if (line.includes('_pyodide') || line.includes('eval_code_async') || line.includes('CodeRunner')) {
        skippingInternal = true;
        continue;
      }
      if (
        skippingInternal &&
        (line.trim().startsWith('await ') ||
          line.trim().startsWith('self.') ||
          line.trim().startsWith('mod = ') ||
          line.trim().startsWith('^^^^'))
      ) {
        continue;
      }
      skippingInternal = false;
      filteredLines.push(line.replace('File "<exec>"', 'File "main.py"'));
    }
    cleanErr = filteredLines.join('\n').trim() || errStr;

    stderrBuffer += (stderrBuffer ? '\n' : '') + cleanErr;
    onStderr?.(cleanErr);
  } finally {
    delete window.__pydroid_tty_stdout;
    delete window.__pydroid_tty_stderr;
  }

  let finalStdout = '';
  try {
    finalStdout = pyodide.runPython('"".join(_pydroid_stdout_buffer)');
  } catch {
    finalStdout = stdoutBuffer;
  }

  const duration = Math.round(performance.now() - startTime);

  return {
    stdout: finalStdout || stdoutBuffer,
    stderr: stderrBuffer,
    exitCode,
    duration,
    engine: 'Pyodide 0.26.4 (WASM TTY Emulated)',
    plotImages,
    isWaitingInput: false,
  };
}
