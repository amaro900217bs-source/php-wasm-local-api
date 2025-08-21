# 📄 php-wasm-local-api -- Documentation

## 🔎 Overview\
`php-wasm-local-api` is a small library that allows executing **PHP directly in the browser** using **WebAssembly (WASM)** and **Web Workers**.

It provides:\
- A **worker pool** for concurrent PHP execution.\
- A **virtual filesystem** (`/www`) to host PHP files.\
- An API (`php.run`, `php.runInline`) to execute PHP scripts and capture their output.\
- Automatic installation of project files from `www.zip`.

The main goal is to make PHP execution **non-blocking** and **parallelizable** in client-side web applications.

---

## ⚙️ Workflow

The flow of `php-wasm-local-api` can be divided into **4 phases**:

### 1. WASM Preload\
- The main script (`wasm_module.js`) fetches the **PHP runtime binary** (`php-web.js.wasm` or `php-web.js.wasm.gz`).\
- The binary is stored in memory (`wasmBinaryBuffer`) and passed to workers later.\
- This avoids fetching the binary multiple times.

---

### 2. Worker Pool Initialization\
- A pool of Web Workers is created (`NUM_WORKERS`, default: 2--4).\
- Each worker:\
  1. Receives the WASM binary.\
  2. Configures itself (`type: 'config'`).\
  3. Runs a **warm-up script** (defined in `window.WARM_UP_SCRIPT`) to validate it can execute PHP.\
- The pool keeps track of:\
  - **Available workers** (ready for execution).\
  - **Pending requests** (currently executing).\
  - **Request queue** (jobs waiting for a worker).

This ensures multiple PHP scripts can run in parallel without blocking the browser.

---

### 3. PHP Script Execution\
When a script is requested via the API:\
- `php.run(path)`\
  - Reads a PHP file from the virtual filesystem (`/www/script.php`).\
  - Wraps it in a `require` call.\
  - Executes it inside a worker.\
- `php.runInline(code)`\
  - Executes raw PHP code directly inside a worker.

**Execution process inside a worker (`worker-php.js`):**\
1\. Ensure **PhpWeb runtime** is initialized with the WASM binary.\
2\. Ensure the virtual filesystem `/www` is mounted and populated:\
   - If `/www/INSTALLED` does not exist:\
     - Download `www.zip`.\
     - Unzip it with **fflate**.\
     - Write contents into `/www`.\
3\. Refresh the runtime (`php.refresh()`).\
4\. Run the given code or file.\
5\. Capture `stdout` / `stderr` via `output` and `error` events.\
6\. Send results back to the main thread as `{ success, result }` or `{ success: false, error }`.

---

### 4. Request Lifecycle\
Each API call follows this lifecycle:

1\. **Request queued**\
   - A unique `requestId` is generated.\
   - The request is stored in `requestQueue`.

2\. **Worker assigned**\
   - A free worker is marked as busy.\
   - Request is dispatched via `postMessage`.

3\. **Execution in worker**\
   - Worker runs the PHP code.\
   - Sends back `{ id, success, result/error }`.

4\. **Completion**\
   - Worker is marked as available again.\
   - Pending request is resolved or rejected.\
   - Queue is processed again.

This mechanism guarantees **fair scheduling** and avoids overloading any single worker.

---

## 📂 Dependencies

### Runtime\
- **[php-wasm](https://github.com/oraoto/php-wasm)** → Provides the `PhpWeb` class, a WebAssembly build of PHP.\
- **[fflate](https://github.com/101arrowz/fflate)** → Efficient zip decompression in the browser (used for `www.zip`).\
- **WebAssembly + Web Workers** → Native browser technologies required.

### Files\
- `php-web.js.wasm` (or compressed `php-web.js.wasm.gz`) → PHP runtime binary.\
- `www.zip` → Contains the initial project files to be extracted into `/www`.

---

## 🚀 Typical Flow -- End to End

```text\
[Main Thread]\
   |\
   |  Load wasm_module.js\
   |  ↓\
   |  Preload php-web.js.wasm\
   |  ↓\
   |  Create Worker Pool\
   |  ↓\
   |  Warm-up workers with inline PHP test\
   |\
   |---------------------------------------------|\
   | User calls php.run("/www/script.php")       |\
   |---------------------------------------------|\
   |\
   v\
[Worker]\
   |  Load PhpWeb runtime with wasmBinary\
   |  Ensure /www is installed (via www.zip)\
   |  ↓\
   |  Run script (or inline PHP code)\
   |  ↓\
   |  Capture output\
   |  ↓\
   |  Send result back to main thread\
   v\
[Main Thread]\
   |  Resolve Promise → return output to user

text```

---

## 📂 Basic example (apart from the 3 examples already in repo):

<!doctype html>\
<html lang="en">\
<head>\
<meta charset="utf-8" />\
<title>php-wasm-local-api test</title>\
</head>\
<body>\
  <h1>php-wasm-local-api test</h1>\
  <button onclick="runFile()">Run /www/hello.php</button>\
  <button onclick="runInline()">Run Inline PHP</button>\
  <pre id="out">Output will appear here...</pre>

  <script>\
    // Global settings\
    window.DEBUG = true;\
    window.NUM_WORKERS = 2;\
    window.WARM_UP_SCRIPT = `<?php echo "Warm-up OK\n"; ?>`;\
  </script>

  <!-- Load the library -->\
  <script type="module" src="./wasm_module.js"></script>

  <script>\
    const out = document.getElementById('out');\
    function log(msg){ out.textContent += "\n" + msg; }

    async function runFile(){\
      log("> php.run('/www/hello.php')");\
      try {\
        const res = await window.php.run("/www/hello.php");\
        log(res || "(no output)");\
      } catch(err){ log("[ERROR] " + err); }\
    }

    async function runInline(){\
      log("> php.runInline('<?php echo 2+3; ?>')");\
      try {\
        const res = await window.php.runInline("<?php echo 2+3; ?>");\
        log(res || "(no output)");\
      } catch(err){ log("[ERROR] " + err); }\
    }\
  </script>\
</body>\
</html>

----

## ⚡ Quick Start\
```bash\
git clone https://github.com/your-org/php-wasm-local-api.git\
cd php-wasm-local-api\
npm install\
npm run dev
