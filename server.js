// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let clients = {};      // instâncias por nome de sessão
let qrAttempts = {};

function getTimestamp() {
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const mozTime = new Date(utc + 2 * 3600000);
  const dia = String(mozTime.getDate()).padStart(2,'0');
  const mes = String(mozTime.getMonth()+1).padStart(2,'0');
  const ano = mozTime.getFullYear();
  const hora = String(mozTime.getHours()).padStart(2,'0');
  const min = String(mozTime.getMinutes()).padStart(2,'0');
  const seg = String(mozTime.getSeconds()).padStart(2,'0');
  return `${dia}/${mes}/${ano} ${hora}:${min}:${seg}`;
}

function log(socket, sessionName, msg) {
  const formatted = `[${sessionName}] ${getTimestamp()} ➝ ${msg}`;
  console.log(formatted);
  if (socket) socket.emit('log', formatted);
}

// Lê recursivamente ficheiros úteis de sessão dentro de .wwebjs_auth
function loadSessionData(sessionName) {
  const authRoot = path.join(__dirname, '.wwebjs_auth');
  const result = {};

  if (!fs.existsSync(authRoot)) return result;

  // candidates: possíveis pastas que contêm a sessão
  const candidates = new Set();

  const candidatePaths = [
    path.join(authRoot, `session-${sessionName}`),
    path.join(authRoot, sessionName),
    path.join(authRoot, 'Default')
  ];
  candidatePaths.forEach(p => { if (fs.existsSync(p) && fs.lstatSync(p).isDirectory()) candidates.add(p); });

  // também adiciona quaisquer subpastas que contenham o nome da sessão
  const subdirs = fs.readdirSync(authRoot, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => path.join(authRoot, d.name));
  subdirs.forEach(d => {
    const base = path.basename(d).toLowerCase();
    if (base.includes(sessionName.toLowerCase()) || base.startsWith('session-')) candidates.add(d);
  });

  // se não há candidate específico, lê todas as subpastas (útil em setups diferentes)
  if (candidates.size === 0) {
    subdirs.forEach(d => candidates.add(d));
  }

  // Função que lê arquivos recursivamente da pasta e só tenta JSON em .json
  function readDirRec(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
      const p = path.join(dir, entry.name);
      const rel = path.relative(authRoot, p); // chave mais legível
      try {
        if (entry.isDirectory()) {
          readDirRec(p);
        } else {
          const ext = path.extname(entry.name).toLowerCase();
          if (ext === '.json') {
            try {
              const content = fs.readFileSync(p, 'utf8');
              result[rel] = JSON.parse(content);
            } catch (e) {
              result[rel] = `⚠️ JSON inválido: ${e.message}`;
            }
          } else {
            // ficheiros não-json (p.ex. DevToolsActivePort) -> lemos só se for pequeno e texto
            const stat = fs.statSync(p);
            if (stat.size < 2000) {
              try {
                result[rel] = fs.readFileSync(p, 'utf8');
              } catch {
                result[rel] = `⚠️ Não foi possível ler (pequeno)`;
              }
            } else {
              result[rel] = `⚠️ Arquivo binário/maior omitido (${stat.size} bytes)`;
            }
          }
        }
      } catch (err) {
        result[rel] = `⚠️ Erro leitura: ${err.message}`;
      }
    });
  }

  for (const dir of candidates) {
    readDirRec(dir);
  }

  return result;
}

function startSession(socket, sessionName) {
  if (clients[sessionName]) {
    log(socket, sessionName, `⚠️ Sessão "${sessionName}" já em andamento`);
    return;
  }

  log(socket, sessionName, `🚀 Iniciando sessão...`);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: sessionName }),
    puppeteer: { headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] }
  });

  clients[sessionName] = client;
  qrAttempts[sessionName] = 0;

  client.on('qr', qr => {
    qrAttempts[sessionName]++;
    if (qrAttempts[sessionName] > 15) {
      log(socket, sessionName, `❌ Tentativas de QR excedidas`);
      client.destroy();
      delete clients[sessionName];
      delete qrAttempts[sessionName];
      socket.emit('session-ended', { session: sessionName, reason: 'Tentativas de QR excedidas' });
      return;
    }
    socket.emit('qr', { session: sessionName, qr, attempt: qrAttempts[sessionName] });
    log(socket, sessionName, `📷 QR recebido (tentativa ${qrAttempts[sessionName]})`);
  });

  client.on('ready', async () => {
    log(socket, sessionName, `✅ Sessão pronta!`);
    try {
      // carrega os ficheiros de sessão (apenas JSON úteis)
      const sessionFiles = loadSessionData(sessionName);

      // envia info de forma estruturada (não stringificada aqui)
      const sessionData = {
        session: sessionName,
        status: 'ready',
        info: client.info || {},
        tokens: sessionFiles
      };

      socket.emit('session-data', sessionData);
      log(socket, sessionName, `📌 Dados da sessão enviados ao cliente`);
    } catch (err) {
      log(socket, sessionName, `⚠️ Erro ao coletar dados da sessão: ${err.message}`);
    }
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
    try { client.destroy(); } catch {}
    delete clients[sessionName];
    delete qrAttempts[sessionName];
    socket.emit('session-ended', { session: sessionName, reason });
  });

  setImmediate(() => {
    try {
      client.initialize();
      log(socket, sessionName, `🔧 Inicializando cliente...`);
    } catch (err) {
      log(socket, sessionName, `❌ Erro ao inicializar cliente: ${err.message}`);
    }
  });
}

io.on('connection', socket => {
  console.log('🔌 Novo cliente conectado');
  socket.emit('log', '🔌 Conectado ao servidor');

  socket.on('start-session', sessionName => {
    if (!sessionName || typeof sessionName !== 'string' || sessionName.trim().length === 0) {
      socket.emit('log', '❌ Nome da sessão não pode ser vazio');
      return;
    }
    startSession(socket, sessionName.trim());
  });
});

const PORT = 3000;
server.listen(PORT, () => console.log(`🌐 Servidor rodando em http://localhost:${PORT}`));
            
