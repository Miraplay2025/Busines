// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const cors = require('cors');

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

// Salva sessão em disco
async function saveSessionData(sessionName) {
  try {
    const authDir = path.join(__dirname, '.wwebjs_auth', sessionName);
    const targetDir = path.join(__dirname, 'conectado', sessionName);
    await fsp.mkdir(targetDir, { recursive: true });

    async function copyRecursively(srcDir, destDir) {
      const entries = await fsp.readdir(srcDir, { withFileTypes: true });
      for (const entry of entries) {
        const srcPath = path.join(srcDir, entry.name);
        const destPath = path.join(destDir, entry.name);
        if (entry.isDirectory()) {
          await fsp.mkdir(destPath, { recursive: true });
          await copyRecursively(srcPath, destPath);
        } else {
          await fsp.copyFile(srcPath, destPath);
        }
      }
    }

    if (fs.existsSync(authDir)) await copyRecursively(authDir, targetDir);
  } catch (e) {
    console.error(`Erro ao salvar sessão "${sessionName}":`, e.message);
  }
}

// Carrega sessão salva em JSON
async function loadSavedSession(sessionName) {
  const baseDir = path.join(__dirname, 'conectado', sessionName);
  const result = {};

  async function readDirRec(dir, obj) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      const rel = path.relative(baseDir, p);
      if (entry.isDirectory()) {
        obj[rel] = {};
        await readDirRec(p, obj[rel]);
      } else {
        try {
          const ext = path.extname(entry.name).toLowerCase();
          if (ext === '.json') {
            obj[rel] = JSON.parse(await fsp.readFile(p, 'utf8'));
          } else {
            const stat = await fsp.stat(p);
            if (stat.size < 2000) {
              obj[rel] = await fsp.readFile(p, 'utf8');
            } else {
              obj[rel] = `⚠️ Arquivo binário/maior omitido (${stat.size} bytes)`;
            }
          }
        } catch (err) {
          obj[rel] = `⚠️ Erro leitura: ${err.message}`;
        }
      }
    }
  }

  if (fs.existsSync(baseDir)) await readDirRec(baseDir, result);
  return result;
}

// Inicializa sessão WhatsApp
function startSession(socket, sessionName) {
  if (clients[sessionName]) {
    log(socket, sessionName, `⚠️ Sessão "${sessionName}" já em andamento`);
    return;
  }

  log(socket, sessionName, `🚀 Iniciando sessão...`);
  qrAttempts[sessionName] = 0;

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: sessionName }),
    puppeteer: { headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] }
  });

  clients[sessionName] = client;
  let qrInterval;

  client.on('qr', qr => {
    qrAttempts[sessionName]++;
    socket.emit('qr', { session: sessionName, qr, attempt: qrAttempts[sessionName] });
    log(socket, sessionName, `📷 QR atualizado (tentativa ${qrAttempts[sessionName]})`);

    if (qrAttempts[sessionName] >= 15) {
      log(socket, sessionName, `❌ Limite de tentativas atingido.`);
      socket.emit('session-ended', { session: sessionName, reason:'Limite QR' });
      safelyDestroySession(sessionName, socket);
    }
  });

  client.on('ready', async () => {
    log(socket, sessionName, `✅ Sessão pronta!`);
    await saveSessionData(sessionName);
    const savedData = await loadSavedSession(sessionName);
    socket.emit('session-data', {
      session: sessionName,
      status: 'ready',
      info: client.info,
      tokens: savedData
    });
  });

  client.on('message', message => {
    log(socket, sessionName, `💬 ${message.from}: ${message.body}`);
    socket.emit('message', { session: sessionName, message });
  });

  client.on('auth_failure', msg => {
    log(socket, sessionName, `❌ Falha de autenticação: ${msg}`);
  });

  client.on('disconnected', reason => {
    log(socket, sessionName, `❌ Sessão desconectada: ${reason}`);
    socket.emit('session-ended', { session: sessionName, reason });
    safelyDestroySession(sessionName, socket);
  });

  try {
    client.initialize();
    log(socket, sessionName, `🔧 Cliente inicializado`);

    qrInterval = setInterval(() => {
      if (qrAttempts[sessionName] >= 15) {
        safelyDestroySession(sessionName, socket);
        clearInterval(qrInterval);
      }
    }, 5000);
  } catch (err) {
    log(socket, sessionName, `❌ Erro ao inicializar cliente: ${err.message}`);
  }
}

// Finaliza sessão com segurança
function safelyDestroySession(sessionName, socket) {
  try {
    if (clients[sessionName]) {
      clients[sessionName].destroy();
      delete clients[sessionName];
    }
    qrAttempts[sessionName] = 0;
    log(socket, sessionName, `🛑 Sessão encerrada`);
  } catch (e) {
    console.error(`Erro ao encerrar sessão ${sessionName}:`, e.message);
  }
}

// Endpoint para listar sessões
app.get('/sessions', async (req,res) => {
  const sessionsDir = path.join(__dirname,'conectado');
  let result = {};
  if (fs.existsSync(sessionsDir)) {
    const dirs = await fsp.readdir(sessionsDir, { withFileTypes:true });
    for (const dir of dirs) {
      if (dir.isDirectory()) {
        result[dir.name] = await loadSavedSession(dir.name);
      }
    }
  }
  res.json(result);
});

// Socket.io
io.on('connection', socket => {
  socket.on('start-session', sessionName => {
    if (!sessionName || typeof sessionName !== 'string' || sessionName.trim().length === 0) {
      socket.emit('log','❌ Nome da sessão não pode ser vazio');
      return;
    }
    startSession(socket, sessionName.trim());
  });
});

// Captura erros globais
process.on('uncaughtException', err => {
  console.error('❌ Erro não tratado:', err);
});
process.on('unhandledRejection', err => {
  console.error('❌ Promessa rejeitada:', err);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🌐 Servidor rodando na porta ${PORT}`));
        
