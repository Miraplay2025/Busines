/* STREAMING_CHUNK: Importing required modules and initializing Express server */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const archiver = require('archiver');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

/* STREAMING_CHUNK: Configuring global middlewares */
app.use(cors());
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Estruturas de memória para instâncias e contadores de QR Code
const clients = {};
const qrAttempts = {};

/* STREAMING_CHUNK: Defining logging utility function */
/**
 * Emite logs sincronizados para o console do terminal e para o cliente via Socket.IO
 */
function log(socket, session, msg) {
  const formattedMsg = `[${session}] ${msg}`;
  console.log(formattedMsg);
  if (socket && socket.connected) {
    socket.emit('log', formattedMsg);
  }
}

/* STREAMING_CHUNK: Defining session helper functions */
/**
 * Retorna os nomes de todas as sessões que estão ativas e com conexão confirmada
 */
function getActiveSessions() {
  return Object.keys(clients).filter(s => {
    return clients[s] && clients[s].info && clients[s].info.connected;
  });
}

/**
 * Aguarda a gravação física dos arquivos de autenticação no disco
 */
async function waitForAuthFolder(authPath, socket, session) {
  log(socket, session, '⏳ Aguardando gravação física dos tokens de sessão...');
  for (let i = 0; i < 15; i++) {
    if (fs.existsSync(authPath) && fs.readdirSync(authPath).length > 0) {
      log(socket, session, '📁 Pasta de autenticação confirmada no sistema!');
      return true;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  log(socket, session, '⚠️ Aviso: A pasta de sessão demorou para responder, prosseguindo...');
  return false;
}

/* STREAMING_CHUNK: Extracting profile and group information */
/**
 * Extrai o nome da conta, número e a lista simples dos grupos participantes
 */
async function getAccountInfo(client) {
  try {
    const me = await client.getMe();
    const chats = await client.getChats();
    const groups = chats.filter(c => c.isGroup);

    const groupData = groups.map(group => ({
      id: group.id._serialized,
      name: group.name
    }));

    return {
      name: me ? (me.pushname || 'Conta WhatsApp') : 'Conta WhatsApp',
      number: me ? (me.number ? me.number._serialized : 'Desconhecido') : 'Desconhecido',
      groups: groupData
    };
  } catch (err) {
    throw new Error('Falha ao extrair informações do perfil: ' + err.message);
  }
}

/* STREAMING_CHUNK: Managing WhatsApp instance lifecycle */
/**
 * Inicia e gerencia o ciclo de vida da instância do WhatsApp Web
 */
function startSession(socket, session) {
  // Evita reinicializar instâncias já existentes
  if (clients[session]) {
    log(socket, session, '⚠️ Esta sessão já está em execução no servidor!');
    return;
  }

  qrAttempts[session] = 0;
  log(socket, session, '🚀 Inicializando motor do WhatsApp (Puppeteer)...');

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: session }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ]
    }
  });

  clients[session] = client;

  // Evento de geração do QR Code
  client.on('qr', qr => {
    qrAttempts[session]++;
    socket.emit('qr', { session, qr, attempt: qrAttempts[session] });
    log(socket, session, `📷 QR Code gerado (${qrAttempts[session]}/15)`);

    if (qrAttempts[session] >= 15) {
      socket.emit('session-ended', { session, reason: 'Tentativas de QR Code esgotadas' });
      log(socket, session, '❌ Limite de QR Codes atingido. Encerrando instância.');
      client.destroy().catch(() => {});
      delete clients[session];
    }
  });

  // Evento quando a sessão está conectada e pronta
  client.on('ready', async () => {
    log(socket, session, '🔐 Autenticação concluída! Conectado ao WhatsApp.');
    const authPath = path.join(__dirname, '.wwebjs_auth', `session-${session}`);
    await waitForAuthFolder(authPath, socket, session);

    try {
      const accountInfo = await getAccountInfo(client);
      
      // Marca status de conexão de forma segura
      if (!client.info) client.info = {};
      client.info.connected = true;

      log(socket, session, '📊 Dados do perfil e grupos sincronizados com sucesso!');
      socket.emit('session-ready', { session, accountInfo });

      // Transmite a lista atualizada de sessões para todos os clientes conectados
      io.emit('update-active-sessions', { sessions: getActiveSessions() });

    } catch (e) {
      log(socket, session, '❌ Erro ao ler dados da conta: ' + e.message);
      socket.emit('session-ready', { session, error: e.message });
    }
  });

  // Evento de desconexão
  client.on('disconnected', reason => {
    log(socket, session, `❌ Sessão desconectada. Motivo: ${reason}`);
    if (clients[session] && clients[session].info) {
      clients[session].info.connected = false;
    }
    socket.emit('session-ended', { session, reason });

    // Atualiza todos os clientes
    io.emit('update-active-sessions', { sessions: getActiveSessions() });
    
    // Limpa a memória
    delete clients[session];
  });

  // Inicializa o processo do Puppeteer
  client.initialize().catch(err => {
    log(socket, session, '❌ Erro fatal ao inicializar o WhatsApp: ' + err.message);
    delete clients[session];
  });
}

/* STREAMING_CHUNK: Handling ZIP packaging of session files */
/**
 * Converte o diretório de autenticação da sessão em um arquivo ZIP enviado via Base64
 */
function createSessionZipBuffer(authPath) {
  return new Promise((resolve, reject) => {
    const buffers = [];
    const archive = archiver('zip', { zlib: { level: 9 } });

    archive.on('data', data => buffers.push(data));
    archive.on('end', () => resolve(Buffer.concat(buffers)));
    archive.on('error', err => reject(err));

    archive.directory(authPath, false);
    archive.finalize();
  });
}

/* STREAMING_CHUNK: Configuring Socket.IO listeners */
io.on('connection', socket => {
  log(socket, 'SERVER', `🔌 Novo cliente conectado (ID: ${socket.id})`);

  // Sincroniza lista de sessões ativas com o cliente assim que ele se conecta
  const active = getActiveSessions();
  if (active.length === 0) {
    socket.emit('update-active-sessions', { sessions: [], message: 'Nenhuma sessão ativa' });
  } else {
    socket.emit('update-active-sessions', { sessions: active });
  }

  // Evento: Iniciar uma nova sessão
  socket.on('start-session', rawSessionName => {
    if (!rawSessionName || typeof rawSessionName !== 'string' || !rawSessionName.trim()) {
      socket.emit('log', '❌ Nome de sessão inválido fornecido.');
      return;
    }
    const sessionName = path.basename(rawSessionName.trim());
    startSession(socket, sessionName);
  });

  // Evento: Solicitar download dos dados da sessão em ZIP
  socket.on('download-session', async rawSessionName => {
    if (!rawSessionName || typeof rawSessionName !== 'string') {
      return socket.emit('log', '❌ Selecione uma sessão válida para realizar o download.');
    }

    const sessionName = path.basename(rawSessionName.trim());
    const authPath = path.join(__dirname, '.wwebjs_auth', `session-${sessionName}`);

    if (!fs.existsSync(authPath)) {
      log(socket, sessionName, `❌ Arquivos não encontrados no diretório: ${authPath}`);
      return socket.emit('log', `❌ Erro: Os arquivos da sessão "${sessionName}" não foram encontrados no servidor.`);
    }

    try {
      log(socket, sessionName, '📦 Compactando arquivos de autenticação em formato ZIP...');
      
      const zipBuffer = await createSessionZipBuffer(authPath);
      const base64Zip = zipBuffer.toString('base64');

      socket.emit('session-zip-data', {
        session: sessionName,
        zipBase64: base64Zip,
        fileName: `session-${sessionName}.zip`
      });

      log(socket, sessionName, '✅ Arquivo ZIP gerado e enviado com sucesso ao navegador!');

    } catch (e) {
      log(socket, sessionName, '❌ Falha ao empacotar os arquivos de sessão: ' + e.message);
    }
  });

  // Evento: Enviar mensagem individual
  socket.on('send-message', async info => {
    if (!info || !info.session || !info.number || !info.text) {
      return socket.emit('msg-status', { error: 'Dados incompletos para envio de mensagem.' });
    }

    const sessionName = path.basename(info.session.trim());
    const client = clients[sessionName];

    if (!client || !client.info || !client.info.connected) {
      return socket.emit('msg-status', { error: 'A sessão selecionada está inativa ou desconectada.' });
    }

    try {
      // Formata número com sufixo do WhatsApp
      const formattedNum = info.number.includes('@c.us') ? info.number : `${info.number.replace(/\D/g, '')}@c.us`;
      
      await client.sendMessage(formattedNum, info.text);
      socket.emit('msg-status', { success: true, number: info.number });
      log(socket, sessionName, `📩 Mensagem enviada com sucesso para ${info.number}`);
    } catch (e) {
      socket.emit('msg-status', { error: e.message, number: info.number });
      log(socket, sessionName, `❌ Erro ao enviar mensagem para ${info.number}: ${e.message}`);
    }
  });

  socket.on('disconnect', () => {
    console.log(`[SERVER] 🔌 Cliente desconectado (ID: ${socket.id})`);
  });
});

/* STREAMING_CHUNK: Starting HTTP server */
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`===================================================`);
  console.log(`🚀 Servidor WhatsApp Manager rodando na porta ${PORT}`);
  console.log(`===================================================`);
});
