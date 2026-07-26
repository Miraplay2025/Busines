const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const archiver = require('archiver'); // Requer: npm install archiver

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Objetos para clientes ativos e tentativas de QR
const clients = {};
const qrAttempts = {};

// Envia log para o front-end e console
function log(socket, session, msg) {
  const m = `[${session}] ${msg}`;
  console.log(m);
  socket.emit('log', m);
}

// Retorna apenas sessões ativas/conectadas
function getActiveSessions() {
  return Object.keys(clients).filter(s => clients[s] && clients[s].info && clients[s].info.connected);
}

// Espera pasta de autenticação ser criada no sistema de arquivos
async function waitForAuthFolder(authPath, socket, session) {
  log(socket, session, '⏳ Aguardando gravação da sessão WhatsApp...');
  for (let i = 0; i < 15; i++) {
    if (fs.existsSync(authPath) && fs.readdirSync(authPath).length > 0) {
      log(socket, session, '📁 Pasta de sessão detectada!');
      return true;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  log(socket, session, '❌ Não foi possível localizar a pasta de sessão!');
  return false;
}

// Obter informações da conta e lista simples de grupos
async function getAccountInfo(client) {
  const me = await client.getMe();
  const chats = await client.getChats();
  const groups = chats.filter(c => c.isGroup);

  const groupData = groups.map(group => ({
    id: group.id._serialized,
    name: group.name
  }));

  return {
    name: me.pushname || 'Sem nome',
    number: me.number ? me.number._serialized : 'Unknown',
    groups: groupData
  };
}

// Inicia sessão e eventos da instância do WhatsApp
function startSession(socket, session) {
  if (clients[session]) {
    log(socket, session, '⚠️ Sessão já ativa!');
    return;
  }

  qrAttempts[session] = 0;
  log(socket, session, '🚀 Iniciando sessão...');

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: session }),
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
  });

  clients[session] = client;

  client.on('qr', qr => {
    qrAttempts[session]++;
    socket.emit('qr', { session, qr, attempt: qrAttempts[session] });
    log(socket, session, `📷 QR gerado (${qrAttempts[session]}/15)`);

    if (qrAttempts[session] >= 15) {
      socket.emit('session-ended', { session, reason: 'QR expirado' });
      log(socket, session, '❌ QR expirado, encerrando sessão');
      client.destroy();
    }
  });

  client.on('ready', async () => {
    log(socket, session, '🔐 WhatsApp conectado!');
    const authPath = path.join(__dirname, '.wwebjs_auth', `session-${session}`);
    await waitForAuthFolder(authPath, socket, session);

    try {
      const accountInfo = await getAccountInfo(client);
      client.info.connected = true; // Marca como conectado
      log(socket, session, '📊 Informações da conta obtidas com sucesso!');
      socket.emit('session-ready', { session, accountInfo });

      // Atualiza sessões ativas para todos os clientes conectados
      io.emit('update-active-sessions', { sessions: getActiveSessions() });

    } catch (e) {
      log(socket, session, '❌ Erro ao obter informações da conta: ' + e.message);
      socket.emit('session-ready', { session, error: e.message });
    }
  });

  client.on('disconnected', reason => {
    log(socket, session, '❌ Sessão desconectada: ' + reason);
    if (client.info) client.info.connected = false;
    socket.emit('session-ended', { session, reason });

    // Atualiza sessões ativas para todos os clientes
    io.emit('update-active-sessions', { sessions: getActiveSessions() });
  });

  client.initialize();
}

// Configuração dos eventos Socket.IO
io.on('connection', socket => {
  // Envia a lista de sessões ativas no momento da conexão
  const active = getActiveSessions();
  if (active.length === 0) {
    socket.emit('update-active-sessions', { sessions: [], message: 'Nenhuma sessão ativa' });
  } else {
    socket.emit('update-active-sessions', { sessions: active });
  }

  // Evento para iniciar ou retomar uma sessão
  socket.on('start-session', session => {
    if (!session || !session.trim()) {
      socket.emit('log', '❌ Nome da sessão inválido');
      return;
    }
    startSession(socket, session.trim());
  });

  // NOVO: Evento para download da pasta de dados da sessão em ZIP
  socket.on('download-session', async (sessionName) => {
    if (!sessionName) {
      return socket.emit('log', '❌ Nenhuma sessão selecionada para download.');
    }

    const authPath = path.join(__dirname, '.wwebjs_auth', `session-${sessionName}`);

    if (!fs.existsSync(authPath)) {
      log(socket, sessionName, `❌ Pasta de autenticação não encontrada em: ${authPath}`);
      return socket.emit('log', `❌ Erro: Dados de sessão para "${sessionName}" não existem no servidor.`);
    }

    try {
      log(socket, sessionName, '📦 Compactando dados de sessão em arquivo ZIP...');

      const buffers = [];
      const archive = archiver('zip', { zlib: { level: 9 } });

      archive.on('data', data => buffers.push(data));
      archive.on('end', () => {
        const zipBuffer = Buffer.concat(buffers);
        const base64Zip = zipBuffer.toString('base64');
        socket.emit('session-zip-data', {
          session: sessionName,
          zipBase64: base64Zip,
          fileName: `session-${sessionName}.zip`
        });
        log(socket, sessionName, '✅ Arquivo ZIP da sessão gerado e enviado para o navegador!');
      });

      archive.on('error', err => {
        log(socket, sessionName, '❌ Erro ao zipar sessão: ' + err.message);
      });

      archive.directory(authPath, false);
      await archive.finalize();

    } catch (e) {
      log(socket, sessionName, '❌ Erro no processo de exportação ZIP: ' + e.message);
    }
  });

  // Enviar mensagem individual
  socket.on('send-message', async info => {
    const { session, number, text } = info;
    const client = clients[session];
    if (!client || !client.info || !client.info.connected) {
      return socket.emit('msg-status', { error: 'Sessão inválida ou desconectada' });
    }

    try {
      await client.sendMessage(`${number}@c.us`, text);
      socket.emit('msg-status', { success: true, number });
      log(socket, session, `📩 Mensagem enviada para ${number}`);
    } catch (e) {
      socket.emit('msg-status', { error: e.message, number });
      log(socket, session, `❌ Falha ao enviar mensagem para ${number}: ${e.message}`);
    }
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
