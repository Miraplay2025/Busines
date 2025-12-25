const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const cors = require('cors');
const archiver = require('archiver');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] }
});

app.use(cors());
app.use(express.static('public'));

let clients = {};
let qrAttempts = {};

function getTimestamp() {
  return new Date().toLocaleString('pt-BR', { timeZone: 'Africa/Maputo' });
}

function log(socket, sessionName, msg) {
  const formatted = `[${sessionName}] ${getTimestamp()} ➝ ${msg}`;
  console.log(formatted);
  if (socket) socket.emit('log', formatted);
}

/* =========================
   COPIAR PASTA RECURSIVA
========================= */
async function copyDir(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fsp.copyFile(srcPath, destPath);
    }
  }
}

/* =========================
   ZIPAR PASTA INTEIRA
========================= */
function zipDirectory(sourceDir, zipPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => resolve());
    archive.on('error', err => reject(err));

    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

/* =========================
   SALVAR + ZIPAR SESSÃO
========================= */
async function saveAndZipSession(sessionName) {
  const authDir = path.join(__dirname, '.wwebjs_auth', sessionName);
  const targetDir = path.join(__dirname, 'conectado', sessionName);
  const zipDir = path.join(__dirname, 'zips');
  const zipPath = path.join(zipDir, `${sessionName}.zip`);

  if (!fs.existsSync(authDir)) return null;

  await fsp.mkdir(zipDir, { recursive: true });

  if (fs.existsSync(targetDir))
    await fsp.rm(targetDir, { recursive: true, force: true });

  await copyDir(authDir, targetDir);
  await zipDirectory(targetDir, zipPath);

  return zipPath;
}

/* =========================
   INICIAR SESSÃO
========================= */
function startSession(socket, sessionName) {
  if (clients[sessionName]) {
    log(socket, sessionName, `⚠️ Sessão já ativa`);
    return;
  }

  log(socket, sessionName, `🚀 Iniciando sessão`);
  qrAttempts[sessionName] = 0;

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: sessionName }),
    puppeteer: { headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] }
  });

  clients[sessionName] = client;

  client.on('qr', qr => {
    qrAttempts[sessionName]++;
    socket.emit('qr', { session: sessionName, qr, attempt: qrAttempts[sessionName] });
    log(socket, sessionName, `📷 QR gerado (${qrAttempts[sessionName]})`);

    if (qrAttempts[sessionName] >= 15) {
      socket.emit('session-ended', { session: sessionName, reason: 'Limite QR' });
      safelyDestroySession(sessionName, socket);
    }
  });

  client.on('ready', async () => {
    log(socket, sessionName, `✅ Conectado`);

    const zipPath = await saveAndZipSession(sessionName);

    socket.emit('session-ready', {
      session: sessionName,
      status: 'ready',
      info: client.info,
      zipAvailable: !!zipPath,
      zipFile: zipPath ? `/download/${sessionName}` : null
    });
  });

  client.on('message', msg => {
    socket.emit('message', { session: sessionName, message: msg });
  });

  client.on('disconnected', reason => {
    socket.emit('session-ended', { session: sessionName, reason });
    safelyDestroySession(sessionName, socket);
  });

  client.initialize();
}

/* =========================
   ENCERRAR SESSÃO
========================= */
function safelyDestroySession(sessionName, socket) {
  try {
    if (clients[sessionName]) {
      clients[sessionName].destroy();
      delete clients[sessionName];
    }
    qrAttempts[sessionName] = 0;
    log(socket, sessionName, `🛑 Sessão encerrada`);
  } catch (e) {
    console.error(e);
  }
}

/* =========================
   DOWNLOAD DO ZIP
========================= */
app.get('/download/:session', (req, res) => {
  const zipPath = path.join(__dirname, 'zips', `${req.params.session}.zip`);
  if (!fs.existsSync(zipPath)) {
    return res.status(404).send('ZIP não encontrado');
  }
  res.download(zipPath);
});

/* =========================
   SOCKET.IO
========================= */
io.on('connection', socket => {
  socket.on('start-session', sessionName => {
    if (!sessionName || !sessionName.trim()) {
      socket.emit('log', '❌ Nome inválido');
      return;
    }
    startSession(socket, sessionName.trim());
  });
});

/* =========================
   ERROS GLOBAIS
========================= */
process.on('uncaughtException', err => console.error(err));
process.on('unhandledRejection', err => console.error(err));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🌐 Servidor rodando na porta ${PORT}`));
