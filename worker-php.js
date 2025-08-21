// worker-php.js

import { PhpWeb } from './node_modules/php-wasm/PhpWeb.mjs';
import { unzip } from './node_modules/fflate/esm/browser.js';

self.DEBUG = false;

let phpInstance = null;
let isInstalled = false;
let isInstalling = false;
let installPromise = null;
let fsLock = Promise.resolve();
let wasmBuffer = null;
let wasmReadyResolve;
const wasmReady = new Promise(resolve => { wasmReadyResolve = resolve; });
const queuedMessages = [];

async function getPhpInstance() {
  if (!phpInstance) {
    if (!wasmBuffer) throw new Error("WASM aún no recibido en worker");

    phpInstance = new PhpWeb({
      persist: { mountPath: "/www" },
      /*locateFile: filename => {
        const blob = new Blob([wasmBuffer], { type: 'application/wasm' });
        return URL.createObjectURL(blob);
      }*/
      wasmBinary: wasmBuffer
    });
  }
  return phpInstance;
}

function syncFs(phpBin, populate = false) {
  fsLock = fsLock.then(() => new Promise((resolve, reject) => {
    phpBin.FS.syncfs(populate, (err) => err ? reject(err) : resolve());
  }));
  return fsLock;
}

async function isProjectInstalledInFs(phpBin) {
  try { phpBin.FS.stat('/www/INSTALLED'); return true; } catch { return false; }
}

async function unzipAndInstallPhpFiles(phpBin, zipData) {
  return new Promise((resolve, reject) => {
    unzip(new Uint8Array(zipData), (err, files) => {
      if (err) return reject(err);
      try {
        for (const relativePath in files) {
          const content = files[relativePath];
          const fullPath = `/www/${relativePath}`;
          const parentDir = fullPath.substring(0, fullPath.lastIndexOf("/"));
          try { phpBin.FS.mkdirTree(parentDir); } catch {}
          if (content.length === 0 && relativePath.endsWith("/")) {
            try { phpBin.FS.mkdir(fullPath); } catch {}
          } else {
            const data = content instanceof Uint8Array ? content : new Uint8Array(content);
            phpBin.FS.writeFile(fullPath, data);
          }
        }
        phpBin.FS.writeFile('/www/INSTALLED', new TextEncoder().encode('OK'));
        phpBin.FS.syncfs(false, (err) => err ? reject(err) : resolve());
      } catch (err) { reject(err); }
    });
  });
}

async function ensureProjectInstalled() {
  if (isInstalled) return true;
  if (isInstalling) return installPromise;

  isInstalling = true;
  installPromise = (async () => {
    try {
      const php = await getPhpInstance();
      const phpBin = await php.binary;
      await syncFs(phpBin, true);
      if (await isProjectInstalledInFs(phpBin)) { isInstalled = true; return true; }

      const response = await fetch('www.zip');
      if (!response.ok) throw new Error(`No se pudo descargar www.zip: ${response.statusText}`);
      const zipData = await response.arrayBuffer();
      await unzipAndInstallPhpFiles(phpBin, zipData);
      isInstalled = true;
      return true;
    } finally { isInstalling = false; }
  })();
  return installPromise;
}

async function runScriptByPath(path) {
  if (!path) throw new Error("No se especificó la ruta del script PHP");
  let code = `<?php
    error_reporting(E_ALL);
    ini_set('display_errors', 1);
    require '${path}';
  `;
  return await runScriptInline(code);
}

async function runScriptInline(code) {
  if (!code) throw new Error("No se especificó el código PHP");
  const php = await getPhpInstance();
  const outputBuffer = [];

  const handleOutput = (e) => {
    const msg = e.detail instanceof Uint8Array ? new TextDecoder().decode(e.detail) : String(e.detail);
    outputBuffer.push(msg);
    if (self.DEBUG) console.log(`[Worker ${self.name || 'PHP'}] Output: ${msg}`);
  };

  const handleError = (e) => {
    const msg = e.detail instanceof Uint8Array ? new TextDecoder().decode(e.detail) : String(e.detail);
    if (self.DEBUG) console.error(`[Worker ${self.name || 'PHP'}] Error: ${msg}`);
    outputBuffer.push(msg);
  };

  php.addEventListener("output", handleOutput);
  if (self.DEBUG) php.addEventListener("error", handleError);

  try {
    await php.refresh();
    await php.run(code);
    return outputBuffer.join("\n");
  } catch (err) {
    throw new Error(`Error ejecutando código PHP:\n${outputBuffer.join("\n") || err.toString()}`);
  } finally {
    php.removeEventListener("output", handleOutput);
    if (self.DEBUG) php.removeEventListener("error", handleError);
  }
}

self.addEventListener('message', async (event) => {
  const { type, wasmBuffer: buffer } = event.data;

  if (type === 'loadWasm') {
    wasmBuffer = buffer;
    wasmReadyResolve();
    while (queuedMessages.length > 0) handleMessage(queuedMessages.shift());
    return;
  }

  if (!wasmBuffer) {
    queuedMessages.push(event);
    return;
  }

  handleMessage(event);
});

async function handleMessage(event) {
  const { type, id, path, code, DEBUG } = event.data;
  if (typeof DEBUG !== 'undefined') self.DEBUG = DEBUG;

  const response = { id, type };
  try {
    await wasmReady;
    await getPhpInstance();

    switch (type) {
      case 'config': response.status = 'configured'; response.success = true; break;
      case 'check': response.result = await ensureProjectInstalled(); response.success = true; break;
      case 'install': response.result = await ensureProjectInstalled(); response.success = true; break;
      case 'runInline':
        if (!code) throw new Error("No se especificó el código PHP");
        response.result = await runScriptInline(code);
        response.success = true;
        break;
      case 'run':
        if (!path) throw new Error("No se especificó la ruta del script PHP");
        response.result = await runScriptByPath(path);
        response.success = true;
        break;
      default: throw new Error(`Tipo de mensaje no soportado: ${type}`);
    }
  } catch (err) {
    response.success = false;
    response.error = err.toString();
    if (self.DEBUG) console.error('Error en el worker:', err, { type, path, id });
  }

  self.postMessage(response);
}
