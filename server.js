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
const sessionState = {}; // controla estado real da sessão

function log(socket, session, msg) {
  const text = `[${session}] ${msg}`;
  console.log(text);
  socket?.emit('log', text);
}

/* =========================
   COPY DIR
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
   ZIP DIR
========================= */
function zipDir(source, zipPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => resolve());
    archive.on('error', reject);

    archive.pipe(output);
    archive.directory(source, false);
    archive.finalize();
  });
}

/* =========================
   SAVE + ZIP SESSION
========================= */
async function saveAndZipSession(session, socket) {
  const authDir = path.join(__dirname, '.wwebjs_auth', session);
  const targetDir = path.join(__dirname, 'conectado', session);
  const zipDirPath = path.join(__dirname, 'zips');
  const zipPath = path.join(zipDirPath, `${session}.zip`);

  sessionState[session] = 'waiting-files';
  log(socket, session, '⏳ Aguardando WhatsApp gravar arquivos da sessão...');

  // aguarda garantir que os arquivos existam
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(authDir)) break;
    await new Promise(r => setTimeout(r, 1000));
  }

  if (!fs.existsSync(authDir)) {
    sessionState[session] = 'error';
    log(socket, session, '❌ Pasta de autenticação não encontrada');
    return null;
  }

  sessionState[session] = 'copying';
  log(socket, session, '📁 Copiando arquivos da sessão...');

  await fsp.mkdir(zipDirPath, { recursive: true });

  if (fs.existsSync(targetDir))
    await fsp.rm(targetDir, { recursive: true, force: true });

  await copyDir(authDir, targetDir);

  sessionState[session] = 'zipping';
  log(socket, session, '🗜️ Compactando sessão (ZIP)...');

  await zipDir(targetDir, zipPath);

  sessionState[session] = 'ready';
  log(socket, session, '✅ ZIP criado com sucesso e pronto para download');

  return zipPath;
}

/* =========================
   START SESSION
========================= */
function startSession(socket, session) {
  if (clients[session]) {
    log(socket, session, '⚠️ Sessão já ativa');
    return;
  }

  qrAttempts[session] = 0;
  sessionState[session] = 'starting';
  log(socket, session, '🚀 Iniciando sessão');

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: session }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox']
    }
  });

  clients[session] = client;

  client.on('qr', qr => {
    qrAttempts[session]++;
    sessionState[session] = 'qr';
    socket.emit('qr', { session, qr, attempt: qrAttempts[session] });
    log(socket, session, `📷 QR gerado (${qrAttempts[session]}/15)`);

    if (qrAttempts[session] >= 15) {
      socket.emit('session-ended', { session, reason: 'Limite de QR atingido' });
      destroySession(session, socket);
    }
  });

  client.on('ready', async () => {
    sessionState[session] = 'connected';
    log(socket, session, '🔐 WhatsApp conectado');

    const zipPath = await saveAndZipSession(session, socket);

    if (zipPath) {
      socket.emit('session-ready', {
        session,
        zipStatus: 'ready',
        zipFile: `/download/${session}`
      });
    } else {
      socket.emit('session-ready', {
        session,
        zipStatus: 'error'
      });
    }
  });

  client.on('disconnected', reason => {
    socket.emit('session-ended', { session, reason });
    destroySession(session, socket);
  });

  client.initialize();
}

/* =========================
   DESTROY SESSION
========================= */
function destroySession(session, socket) {
  try {
    clients[session]?.destroy();
    delete clients[session];
    delete sessionState[session];
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
  if (!fs.existsSync(zipPath)) {
    return res.status(404).send('ZIP ainda não está pronto');
  }
  res.download(zipPath);
});

/* =========================
   SOCKET
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`🌐 Servidor rodando na porta ${PORT}`)
);
