// wasm_module.js

window.DEBUG = window.DEBUG ?? false;
window.ENTRY_POINT = window.ENTRY_POINT ?? "";
window.DOC_ROOT = window.DOC_ROOT ?? "/www";
window.NUM_WORKERS = window.NUM_WORKERS ?? 4;
window.WARM_UP_SCRIPT = window.WARM_UP_SCRIPT ?? "";

let isInstallWorkerReady = false;
const installWorkerTasks = [];
let wasmBinaryBuffer = null;

const workerPool = {
  workers: [],
  maxWorkers: window.NUM_WORKERS,
  isInitialized: false,
  pendingRequests: {},
  requestQueue: [],

  async init() {
    if (this.isInitialized) return;

    // Precargar WASM en memoria
    if (!wasmBinaryBuffer) {
      const response = await fetch('./php-web.js.wasm');
      wasmBinaryBuffer = await response.arrayBuffer();
      console.log('WASM precargado en memoria, tamaño:', wasmBinaryBuffer.byteLength);
    }

    const initPromises = [];
    for (let i = 0; i < this.maxWorkers; i++) {
      const worker = new Worker(new URL('./worker-php.js', import.meta.url), { 
        type: 'module',
        name: `php-worker-${i + 1}`
      });

      worker.id = `worker-${i + 1}`;
      worker.available = true;
      worker.onmessage = this.handleWorkerMessage.bind(this, worker);

      // Enviar WASM al worker
      worker.postMessage({ type: 'loadWasm', wasmBuffer: wasmBinaryBuffer.slice(0) });

      // Inicialización
      const initPromise = new Promise((resolve) => {
        const handler = (e) => {
          if (e.data.type === 'config' && e.data.success) {
            worker.removeEventListener('message', handler);

            // Warm-up automático
            this.warmUpWorker(worker).then(() => {
              resolve(worker); // worker listo
            }).catch(err => {
              console.error("Warm-up falló:", err);
              resolve(worker); // no bloqueamos
            });
          }
        };
        worker.addEventListener('message', handler);
        worker.postMessage({ type: 'config', id: `init-${worker.id}`, DEBUG: window.DEBUG });
      });

      this.workers.push(worker);
      initPromises.push(initPromise);
    }

    await Promise.all(initPromises);
    this.isInitialized = true;
    this.processQueue();
    wasmBinaryBuffer = null;
  },

  async warmUpWorker(worker) {
    if (!window.WARM_UP_SCRIPT) return;
    return new Promise((resolve, reject) => {
      const requestId = `warmup-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      
      const handler = (e) => {
        if (e.data.id === requestId) {
          worker.removeEventListener('message', handler);
          if (e.data.success) resolve(e.data.result);
          else reject(new Error(e.data.error));
        }
      };
      
      worker.addEventListener('message', handler);
      worker.postMessage({
        type: 'runInline',
        code: window.WARM_UP_SCRIPT,
        id: requestId,
        DEBUG: window.DEBUG
      });
    });
  },

  handleWorkerMessage(worker, e) {
    const { id, success, error, result } = e.data;
    if (id && this.pendingRequests[id]) {
      const { resolve, reject } = this.pendingRequests[id];
      delete this.pendingRequests[id];
      if (!success) reject(new Error(error));
      else resolve(result);
      worker.available = true;
      this.processQueue();
    }
  },

  processQueue() {
    if (this.requestQueue.length === 0) return;
    const availableWorker = this.workers.find(w => w.available);
    if (!availableWorker) return;

    const { request, resolve, reject } = this.requestQueue.shift();
    const requestId = `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    availableWorker.available = false;
    this.pendingRequests[requestId] = { resolve, reject };

    availableWorker.postMessage({ ...request, id: requestId, DEBUG: window.DEBUG });
  },

  async execute(request) {
    if (!this.isInitialized) await this.init();
    return new Promise((resolve, reject) => {
      this.requestQueue.push({ request, resolve, reject });
      this.processQueue();
    });
  }
};

async function fetchAndDecompressWasm(wasmGzUrl) {
  try {
    const response = await fetch(wasmGzUrl);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }    const decompressionStream = new DecompressionStream('gzip');
    const decompressedReadableStream = response.body.pipeThrough(decompressionStream);
    const reader = decompressedReadableStream.getReader();
    const chunks = [];
    let totalSize = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
      totalSize += value.length;
    }
    const decompressedBuffer = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of chunks) {
      decompressedBuffer.set(chunk, offset);
      offset += chunk.length;
    }
    return decompressedBuffer.buffer;
  } catch (error) {
    console.error('Error fetching or decompressing the WASM file:', error);
    throw error;
  }
}


async function initializeInstallWorker() {
  // Espera a que el WASM esté cargado
  if (!wasmBinaryBuffer) {
    //const response = await fetch('./php-web.js.wasm');
    //wasmBinaryBuffer = await response.arrayBuffer();
    wasmBinaryBuffer = await fetchAndDecompressWasm('./php-web.js.wasm.gz');
    console.log('WASM precargado en memoria (install worker)');
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker-php.js', import.meta.url), { type: 'module' });

    worker.onmessage = (e) => {
      const { id, result, error } = e.data;
      if (error) return reject(new Error(error));

      if (id === 'init-check') {
        if (result && result.needsInstall) {
          worker.postMessage({ type: 'install', id: 'init-install', DEBUG: window.DEBUG });
        } else finishInstallWorker(worker, resolve);
      }
      if (id === 'init-install') finishInstallWorker(worker, resolve);
    };

    // Enviar WASM al worker
    worker.postMessage({ type: 'loadWasm', wasmBuffer: wasmBinaryBuffer.slice(0) });

    worker.postMessage({ type: 'config', DEBUG: window.DEBUG });
    worker.postMessage({ type: 'check', id: 'init-check', DEBUG: window.DEBUG });
  });
}


function finishInstallWorker(worker, resolve) {
  isInstallWorkerReady = true;
  processInstallWorkerTasks();
  worker.terminate();
  resolve();
}

function queueInstallWorkerTask(task) {
  return new Promise((resolve, reject) => {
    installWorkerTasks.push({ task, resolve, reject });
    if (isInstallWorkerReady) processInstallWorkerTasks();
  });
}

function processInstallWorkerTasks() {
  while (installWorkerTasks.length > 0 && isInstallWorkerReady) {
    const { task, resolve, reject } = installWorkerTasks.shift();
    task().then(resolve).catch(reject);
  }
}

initializeInstallWorker()
  .then(() => workerPool.init())
  .then(() => document.dispatchEvent(new Event('php-wasm-ready')));

window.php = {
  async run(path) { return workerPool.execute({ type: 'run', path }); },
  async runInline(code) { return workerPool.execute({ type: 'runInline', code }); }
};
