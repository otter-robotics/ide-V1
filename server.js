/**
 * Otter Robotics – Compile + Upload Server
 *
 * Usage:
 *   npm install && node server.js
 *
 * Requires arduino-cli:
 *   brew install arduino-cli
 *   arduino-cli core install esp32:esp32
 */

const express    = require('express');
const cors       = require('cors');
const fs         = require('fs');
const path       = require('path');
const os         = require('os');
const crypto     = require('crypto');
const { exec, spawn } = require('child_process');

const app  = express();
const PORT = 3000;
const FQBN = 'esp32:esp32:lolin_c3_mini';

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/esptool-js', express.static(path.join(__dirname, 'node_modules/esptool-js')));
app.use(express.static(__dirname));

// ── health ────────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ ok: true }));

// ── list ports ────────────────────────────────────────────────────────────────
app.get('/api/ports', async (req, res) => {
  try {
    const { stdout } = await run('arduino-cli board list --format json', 10_000);
    const data = JSON.parse(stdout || '{}');
    // arduino-cli >= 0.35 uses detected_ports, older uses boards
    const detected = data.detected_ports || data.boards || [];
    const ports = detected.map(entry => {
      const port  = entry.port || entry;
      const board = (entry.matching_boards || [])[0];
      return {
        address: port.address,
        label:   port.label || port.address,
        board:   board ? board.name : null,
        fqbn:    board ? board.fqbn : null,
      };
    });
    res.json({ ports });
  } catch(e) {
    console.error('[ports err]', e.message);
    res.json({ ports: [], error: e.message });
  }
});

// ── compile ───────────────────────────────────────────────────────────────────
app.post('/api/compile', async (req, res) => {
  const { code, fqbn = FQBN } = req.body;
  if (!code || !code.trim()) return res.status(400).json({ error: 'No code provided.' });

  const uid        = crypto.randomBytes(6).toString('hex');
  const sketchName = 'otter_' + uid;
  const sketchDir  = path.join(os.tmpdir(), sketchName, sketchName);

  fs.mkdirSync(sketchDir, { recursive: true });
  fs.writeFileSync(path.join(sketchDir, sketchName + '.ino'), code, 'utf8');

  const cmd = `arduino-cli compile --fqbn "${fqbn}" --export-binaries "${sketchDir}"`;
  console.log('[compile]', sketchName, fqbn);

  try {
    const { stdout, stderr } = await run(cmd, 120_000);
    console.log('[compile ok]', stdout.slice(0, 200));

    const buildDir = path.join(sketchDir, 'build', fqbn.replace(/:/g, '.'));

    const files = [];
    function addFile(file, address) {
      if (fs.existsSync(file)) files.push({ address, data: fs.readFileSync(file).toString('base64') });
    }
    addFile(path.join(buildDir, sketchName + '.ino.bootloader.bin'), 0x0);
    addFile(path.join(buildDir, sketchName + '.ino.partitions.bin'), 0x8000);
    const bootApp = findBootApp(fqbn);
    if (bootApp) addFile(bootApp, 0xe000);
    addFile(path.join(buildDir, sketchName + '.ino.bin'), 0x10000);

    if (files.length === 0) throw new Error('No .bin files found after compilation.');

    const appBin = files.find(f => f.address === 0x10000);
    const size   = appBin ? Buffer.from(appBin.data, 'base64').length : 0;

    // Keep sketchDir for upload — store the path
    // Return sketchId so /api/upload can reference it
    res.json({ files, size, sketchDir, fqbn, stderr: stderr.slice(0, 500) });

  } catch(e) {
    cleanup(path.join(os.tmpdir(), sketchName));
    console.error('[compile err]', e.message);
    res.status(400).json({ error: (e.stderr || e.message || '').toString() });
  }
});

// ── upload (SSE stream) ───────────────────────────────────────────────────────
// Uses arduino-cli upload which internally calls Python esptool — survives USB CDC reconnect
app.post('/api/upload', (req, res) => {
  const { sketchDir, port, fqbn = FQBN } = req.body;
  if (!sketchDir || !port) return res.status(400).json({ error: 'sketchDir and port required.' });

  // Server-Sent Events so we can stream progress
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (type, msg) => {
    res.write(`data: ${JSON.stringify({ type, msg })}\n\n`);
    console.log('[upload]', type, msg);
  };

  send('info', `Uploading to ${port} via arduino-cli…`);

  const cmd = `arduino-cli upload --fqbn "${fqbn}" --port "${port}" "${sketchDir}"`;
  const child = exec(cmd, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });

  child.stdout.on('data', d => d.toString().split('\n').filter(Boolean).forEach(l => send('info', l.trim())));
  child.stderr.on('data', d => d.toString().split('\n').filter(Boolean).forEach(l => {
    const line = l.trim();
    if (!line) return;
    // esptool prints progress to stderr — classify it
    if (/Writing at|Hash of data|Leaving|Hard resetting/i.test(line)) send('ok', line);
    else if (/error|fail/i.test(line)) send('err', line);
    else send('info', line);
  }));

  child.on('close', code => {
    cleanup(sketchDir.replace(/\/[^/]+$/, '')); // remove the outer sketchName dir
    if (code === 0) {
      send('done', 'Upload complete! Board is restarting.');
    } else {
      send('error', 'Upload failed with exit code ' + code);
    }
    res.end();
  });

  child.on('error', e => {
    send('error', e.message);
    res.end();
  });
});

// ── helpers ───────────────────────────────────────────────────────────────────
function run(cmd, timeout) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); }
      else resolve({ stdout, stderr });
    });
  });
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function findBootApp(fqbn) {
  const bases = [
    path.join(os.homedir(), 'Library', 'Arduino15'),
    path.join(os.homedir(), '.arduino15'),
    path.join(process.env.LOCALAPPDATA || '', 'Arduino15'),
  ];
  for (const base of bases) {
    const pkgDir = path.join(base, 'packages', 'esp32', 'hardware', 'esp32');
    if (!fs.existsSync(pkgDir)) continue;
    const versions = fs.readdirSync(pkgDir).sort().reverse();
    for (const ver of versions) {
      const f = path.join(pkgDir, ver, 'tools', 'partitions', 'boot_app0.bin');
      if (fs.existsSync(f)) return f;
    }
  }
  return null;
}

app.listen(PORT, () => {
  console.log('');
  console.log('  ╔═══════════════════════════════════════╗');
  console.log('  ║   Otter Robotics Compile Server       ║');
  console.log('  ║   http://localhost:' + PORT + '                ║');
  console.log('  ╚═══════════════════════════════════════╝');
  console.log('');
});
