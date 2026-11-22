// CPython Native Runner & Server Pip Service (calls server.ts backend)
import { getApiBaseUrl, getApiUrl, fetchWithTimeout, wakeBackendServer } from '../utils/apiConfig';

export interface CPythonRunOptions {
  code: string;
  inputs?: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onStatus?: (message: string) => void;
}

export interface CPythonRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  duration: number;
  engine: string;
  plotImages?: string[];
  isWaitingInput?: boolean;
  prompt?: string;
}

let lastServerWarmAt = 0;

// Silently wake/warm the CPython backend server so subsequent RUN calls have minimal latency
export function prewarmCPythonServer(): void {
  if (typeof window === 'undefined') return;
  const now = Date.now();
  if (now - lastServerWarmAt < 60_000) return;
  lastServerWarmAt = now;

  const healthUrl = getApiUrl('/api/health');
  fetchWithTimeout(healthUrl, { method: 'GET', cache: 'no-store' }, 8000).catch(() => {});
}

export async function runCPythonCode(options: CPythonRunOptions): Promise<CPythonRunResult> {
  const {
    code,
    inputs = [],
    signal,
    timeoutMs = 25000,
    onStdout,
    onStderr,
    onStatus,
  } = options;

  const url = getApiUrl('/api/python/run');
  let response = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream, application/json',
      },
      body: JSON.stringify({ code, inputs }),
      signal,
    },
    timeoutMs
  );

  // If hosted backend (Render/Cloud Run) was sleeping and returned 502/503/504, wake & retry once
  if ([502, 503, 504, 520, 521, 522, 524].includes(response.status) && !signal?.aborted) {
    const base = getApiBaseUrl();
    if (base) {
      onStatus?.('Máy chủ CPython đang thức dậy, vui lòng chờ...');
      const wake = await wakeBackendServer(base, { timeoutMs: 35000, onProgress: onStatus });
      if (wake.ok && !signal?.aborted) {
        response = await fetchWithTimeout(
          url,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'text/event-stream, application/json',
            },
            body: JSON.stringify({ code, inputs }),
            signal,
          },
          timeoutMs
        );
      }
    }
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `Lỗi máy chủ (${response.status})`);
  }

  lastServerWarmAt = Date.now();
  const contentType = response.headers.get('content-type') || '';

  // Stream reading if server returned SSE
  if (contentType.includes('text/event-stream') && response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    const finalResult: CPythonRunResult = {
      stdout: '',
      stderr: '',
      exitCode: 0,
      duration: 0,
      engine: 'CPython 3.10 (Native Linux)',
      plotImages: [],
      isWaitingInput: false,
      prompt: '',
    };

    try {
      while (true) {
        if (signal?.aborted) {
          await reader.cancel().catch(() => {});
          throw new DOMException('Đã dừng thực thi.', 'AbortError');
        }
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() || '';

        for (const block of blocks) {
          const lines = block
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.startsWith('data:'));

          for (const line of lines) {
            const jsonStr = line.slice(5).trim();
            if (!jsonStr) continue;

            let evt: any;
            try {
              evt = JSON.parse(jsonStr);
            } catch {
              continue;
            }

            if (evt.type === 'stdout' && evt.chunk) {
              finalResult.stdout += evt.chunk;
              onStdout?.(evt.chunk);
            } else if (evt.type === 'stderr' && evt.chunk) {
              finalResult.stderr += evt.chunk;
              onStderr?.(evt.chunk);
            } else if (evt.type === 'done') {
              finalResult.stdout = evt.stdout !== undefined ? evt.stdout : finalResult.stdout;
              finalResult.stderr = evt.stderr !== undefined ? evt.stderr : finalResult.stderr;
              finalResult.exitCode = evt.exitCode ?? 0;
              finalResult.duration = evt.duration || 0;
              finalResult.engine = evt.engine || 'CPython 3.10 (Native Linux)';
              finalResult.plotImages = Array.isArray(evt.plotImages) ? evt.plotImages : [];
              finalResult.isWaitingInput = !!evt.isWaitingInput;
              finalResult.prompt = evt.prompt || '';
            } else if (evt.type === 'error') {
              throw new Error(evt.error || 'Lỗi thực thi CPython');
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return finalResult;
  }

  // Fallback normal JSON response
  const data = await response.json();
  if (onStdout && data.stdout) {
    onStdout(data.stdout);
  }
  if (onStderr && data.stderr) {
    onStderr(data.stderr);
  }

  return {
    stdout: data.stdout || '',
    stderr: data.stderr || '',
    exitCode: data.exitCode ?? (data.success ? 0 : 1),
    duration: data.duration || 0,
    engine: data.engine || 'CPython 3.10 (Native Linux)',
    plotImages: Array.isArray(data.plotImages) ? data.plotImages : [],
    isWaitingInput: !!data.isWaitingInput,
    prompt: data.prompt || '',
  };
}

export async function fetchCPythonPipList(): Promise<string[]> {
  try {
    const res = await fetchWithTimeout(
      getApiUrl('/api/python/pip/list'),
      { method: 'GET', cache: 'no-store' },
      10000
    );
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.packages) ? data.packages : [];
  } catch {
    return [];
  }
}

export async function installCPythonPipPackage(packageName: string): Promise<{
  ok: boolean;
  packageName: string;
  output?: string;
}> {
  const res = await fetchWithTimeout(
    getApiUrl('/api/python/pip/install'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packageName }),
    },
    60000
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) {
    throw new Error(data.error || `Không thể cài đặt ${packageName} trên CPython Server.`);
  }
  return {
    ok: true,
    packageName: data.packageName || packageName,
    output: data.output || '',
  };
}
