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

const clients = {};
const qrAttempts = {};

function log(socket, session, msg) {
  const text = `[${session}] ${msg}`;
  console.log(text);
  socket?.emit('log', text);
}

/* =========================
   COPIAR PASTA RECURSIVA
========================= */
async function copyDir(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });

  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else await fsp.copyFile(s, d);
  }
}

/* =========================
   ZIPAR PASTA
========================= */
function zipDir(source, zipPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolve);
    archive.on('error', reject);

    archive.pipe(output);
    archive.directory(source, false);
    archive.finalize();
  });
}

/* =========================
   SALVAR + ZIPAR SESSÃO
========================= */
async function saveAndZipSession(session) {
  const authDir = path.join(__dirname, '.wwebjs_auth', session);
  const targetDir = path.join(__dirname, 'conectado', session);
  const zipDirPath = path.join(__dirname, 'zips');
  const zipPath = path.join(zipDirPath, `${session}.zip`);

  if (!fs.existsSync(authDir)) return null;

  await fsp.mkdir(zipDirPath, { recursive: true });

  if (fs.existsSync(targetDir))
    await fsp.rm(targetDir, { recursive: true, force: true });

  await copyDir(authDir, targetDir);
  await zipDir(targetDir, zipPath);

  return zipPath;
}

/* =========================
   INICIAR SESSÃO
========================= */
function startSession(socket, session) {
  if (clients[session]) {
    log(socket, session, '⚠️ Sessão já ativa');
    return;
  }

  qrAttempts[session] = 0;
  log(socket, session, '🚀 Iniciando sessão');

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: session }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  clients[session] = client;

  client.on('qr', qr => {
    qrAttempts[session]++;
    socket.emit('qr', {
      session,
      qr,
      attempt: qrAttempts[session]
    });

    log(socket, session, `📷 QR gerado (${qrAttempts[session]}/15)`);

    if (qrAttempts[session] >= 15) {
      socket.emit('session-ended', {
        session,
        reason: 'Limite de QR atingido'
      });
      destroySession(session, socket);
    }
  });

  client.on('ready', async () => {
    log(socket, session, '✅ Sessão conectada');

    const zipPath = await saveAndZipSession(session);

    socket.emit('session-ready', {
      session,
      zipFile: zipPath ? `/download/${session}` : null
    });
  });

  client.on('disconnected', reason => {
    socket.emit('session-ended', { session, reason });
    destroySession(session, socket);
  });

  client.on('auth_failure', msg => {
    log(socket, session, `❌ Falha de autenticação: ${msg}`);
  });

  client.initialize();
}

/* =========================
   ENCERRAR SESSÃO
========================= */
function destroySession(session, socket) {
  try {
    clients[session]?.destroy();
    delete clients[session];
    qrAttempts[session] = 0;
    log(socket, session, '🛑 Sessão encerrada');
  } catch (e) {
    console.error(e);
  }
}

/* =========================
   DOWNLOAD ZIP
========================= */
app.get('/download/:session', (req, res) => {
  const zipPath = path.join(__dirname, 'zips', `${req.params.session}.zip`);
  if (!fs.existsSync(zipPath))
    return res.status(404).send('ZIP não encontrado');

  res.download(zipPath);
});

/* =========================
   SOCKET.IO
========================= */
io.on('connection', socket => {
  socket.on('start-session', session => {
    if (!session || !session.trim()) {
      socket.emit('log', '❌ Nome da sessão inválido');
      return;
    }
    startSession(socket, session.trim());
  });
});

/* =========================
   START SERVER
========================= */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`🌐 Servidor rodando na porta ${PORT}`)
);
