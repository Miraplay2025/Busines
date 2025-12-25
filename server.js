const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.static('public'));

const clients = {};
const qrAttempts = {};

function log(socket, session, msg) {
  const m = `[${session}] ${msg}`;
  console.log(m);
  socket.emit('log', m);
}

/* ==========================
   ZIP FOLDER
========================== */
function zipFolder(source, out) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(out);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolve);
    archive.on('error', reject);

    archive.pipe(output);
    archive.directory(source, false);
    archive.finalize();
  });
}

/* ==========================
   WAIT FOR AUTH FILES
========================== */
async function waitForAuthFolder(authPath, socket, session) {
  log(socket, session, '⏳ Aguardando WhatsApp finalizar gravação da sessão...');
  for (let i = 0; i < 15; i++) {
    if (
      fs.existsSync(authPath) &&
      fs.readdirSync(authPath).length > 0
    ) {
      log(socket, session, '📁 Pasta de sessão detectada');
      return true;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

/* ==========================
   START SESSION
========================== */
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
    socket.emit('qr', { session, qr, attempt: qrAttempts[session] });
    log(socket, session, `📷 QR gerado (${qrAttempts[session]}/15)`);

    if (qrAttempts[session] >= 15) {
      socket.emit('session-ended', { session, reason: 'QR expirado' });
      client.destroy();
    }
  });

  client.on('ready', async () => {
    log(socket, session, '🔐 WhatsApp conectado');

    const authPath = path.join(__dirname, '.wwebjs_auth', `session-${session}`);
    const zipDir = path.join(__dirname, 'zips');
    const zipPath = path.join(zipDir, `${session}.zip`);

    if (!fs.existsSync(zipDir)) fs.mkdirSync(zipDir);

    const ok = await waitForAuthFolder(authPath, socket, session);

    if (!ok) {
      log(socket, session, '❌ Falha ao localizar arquivos da sessão');
      socket.emit('session-ready', { session, zipStatus: 'error' });
      return;
    }

    log(socket, session, '🗜️ Compactando pasta da sessão...');
    await zipFolder(authPath, zipPath);

    log(socket, session, '✅ ZIP pronto para download');

    socket.emit('session-ready', {
      session,
      zipStatus: 'ready',
      downloadUrl: `/download/${session}`
    });
  });

  client.on('disconnected', reason => {
    log(socket, session, '❌ Sessão desconectada: ' + reason);
    socket.emit('session-ended', { session, reason });
  });

  client.initialize();
}

/* ==========================
   DOWNLOAD
========================== */
app.get('/download/:session', (req, res) => {
  const zip = path.join(__dirname, 'zips', `${req.params.session}.zip`);
  if (!fs.existsSync(zip)) {
    return res.status(404).send('ZIP ainda não disponível');
  }
  res.download(zip);
});

/* ==========================
   SOCKET
========================== */
io.on('connection', socket => {
  socket.on('start-session', session => {
    if (!session || !session.trim()) {
      socket.emit('log', '❌ Nome da sessão inválido');
      return;
    }
    startSession(socket, session.trim());
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () =>
  console.log(`🌐 Servidor rodando na porta ${PORT}`)
);
