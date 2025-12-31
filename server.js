const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

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

// Envia log para o front-end
function log(socket, session, msg) {
  const m = `[${session}] ${msg}`;
  console.log(m);
  socket.emit('log', m);
}

// Retorna apenas sessões **ativas/conectadas**
function getActiveSessions() {
  return Object.keys(clients).filter(s => clients[s] && clients[s].info && clients[s].info.connected);
}

// Espera pasta de autenticação ser criada
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

// Obter informações da conta e grupos
async function getAccountInfo(client) {
  const me = await client.getMe();
  const chats = await client.getChats();
  const groups = chats.filter(c => c.isGroup);

  const groupData = [];
  for (let group of groups) {
    const participants = group.participants;
    const members = participants
      .filter(p => !p.id.user.startsWith('258'))
      .map(p => p.id.user);

    groupData.push({
      id: group.id._serialized,
      name: group.name,
      members
    });
  }

  return {
    name: me.pushname || 'Sem nome',
    number: me.number ? me.number._serialized : 'Unknown',
    groups: groupData
  };
}

// Inicia sessão
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
      client.info.connected = true; // marca como conectado
      log(socket, session, '📊 Informações da conta e grupos obtidas com sucesso!');
      socket.emit('session-ready', { session, accountInfo });

      // Atualiza sessões ativas para todos os clientes
      io.emit('update-active-sessions', { sessions: getActiveSessions() });

    } catch (e) {
      log(socket, session, '❌ Erro ao obter informações da conta: ' + e.message);
      socket.emit('session-ready', { session, error: e.message });
    }
  });

  client.on('disconnected', reason => {
    log(socket, session, '❌ Sessão desconectada: ' + reason);
    client.info.connected = false;
    socket.emit('session-ended', { session, reason });

    // Atualiza sessões ativas para todos os clientes
    io.emit('update-active-sessions', { sessions: getActiveSessions() });
  });

  client.initialize();
}

// Socket.IO
io.on('connection', socket => {
  // Envia sessões ativas assim que o usuário acessa
  const active = getActiveSessions();
  if (active.length === 0) {
    socket.emit('update-active-sessions', { sessions: [], message: 'Nenhuma sessão ativa' });
  } else {
    socket.emit('update-active-sessions', { sessions: active });
  }

  socket.on('start-session', session => {
    if (!session || !session.trim()) {
      socket.emit('log', '❌ Nome da sessão inválido');
      return;
    }
    startSession(socket, session.trim());
  });

  // Adicionar membros
  socket.on('add-members', async data => {
    const { session, groupId, members } = data;
    const client = clients[session];
    if (!client || !client.info.connected) return socket.emit('add-progress', { error: 'Sessão inválida ou desconectada' });

    let added = 0;
    socket.emit('add-progress', { total: members.length, added });

    for (let m of members) {
      try {
        await client.addParticipant(groupId, `${m}@c.us`);
        added++;
        socket.emit('add-progress', { total: members.length, added });
      } catch (e) {
        socket.emit('add-progress', { total: members.length, added, error: `Erro ao adicionar ${m}: ${e.message}` });
      }
    }

    socket.emit('add-complete', { total: members.length, added });
    log(socket, session, `✅ Adicionados ${added}/${members.length} membros ao grupo`);
  });

  // Enviar mensagem
  socket.on('send-message', async info => {
    const { session, number, text } = info;
    const client = clients[session];
    if (!client || !client.info.connected) return socket.emit('msg-status', { error: 'Sessão inválida ou desconectada' });

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
