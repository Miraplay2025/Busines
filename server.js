const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const archiver = require('archiver');
const unzipper = require('unzipper');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.static('public'));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Mapeamento global de clientes ativas e tentativas de QR
const clients = {};
const qrAttempts = {};

// Garante que o diretório base de autenticações exista no sistema de arquivos
const BASE_AUTH_DIR = path.join(__dirname, '.wwebjs_auth');
if (!fs.existsSync(BASE_AUTH_DIR)) {
  fs.mkdirSync(BASE_AUTH_DIR, { recursive: true });
}

// Função auxiliar para garantir a existência de uma pasta de sessão específica
function ensureAuthFolder(session) {
  const sessionPath = path.join(BASE_AUTH_DIR, `session-${session}`);
  if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
  }
  return sessionPath;
}

// Função auxiliar para emitir logs no console e via WebSocket
function log(socket, session, msg) {
  const formattedMessage = `[${session || 'SISTEMA'}] ${msg}`;
  console.log(formattedMessage);
  if (socket) {
    socket.emit('log', formattedMessage);
  } else {
    io.emit('log', formattedMessage);
  }
}

// Retorna lista de sessões ativas com conexão ativa
function getActiveSessions() {
  return Object.keys(clients).filter(
    s => clients[s] && clients[s].info && clients[s].info.connected
  );
}

// Aguarda a criação da pasta física de autenticação e valida dados gravados
async function waitForAuthFolder(authPath, socket, session) {
  log(socket, session, '⏳ Aguardando gravação física da sessão...');
  
  if (!fs.existsSync(authPath)) {
    fs.mkdirSync(authPath, { recursive: true });
  }

  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(authPath)) {
      const files = fs.readdirSync(authPath);
      if (files.length > 0) {
        log(socket, session, '📁 Pasta de autenticação localizada e dados gravados!');
        return true;
      }
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  log(socket, session, '⚠️ Pasta localizada, prosseguindo com sincronização...');
  return true;
}

// Extrai dados da conta conectada de forma segura e tolerante a falhas
async function getAccountInfo(client) {
  // Obtém informações básicas diretamente da propriedade .info da instância
  const meInfo = client.info || {};
  const pushname = meInfo.pushname || (meInfo.wid && meInfo.wid.user) || 'Conta WhatsApp';
  const number = meInfo.wid ? meInfo.wid._serialized : (meInfo.me ? meInfo.me._serialized : 'Desconhecido');

  let groupData = [];
  try {
    // Aguarda um pequeno intervalo para o motor do WhatsApp Web carregar os chats na memória
    await new Promise(r => setTimeout(r, 2000));
    const chats = await client.getChats();
    const groups = chats.filter(c => c.isGroup);

    groupData = groups.map(group => ({
      id: group.id._serialized,
      name: group.name
    }));
  } catch (err) {
    console.error('Aviso: Não foi possível obter a lista completa de grupos no momento:', err.message);
  }

  return {
    name: pushname,
    number: number,
    groups: groupData
  };
}

// Inicializa ou retoma uma sessão WhatsApp Web
function startSession(socket, session) {
  if (clients[session]) {
    log(socket, session, '⚠️ Sessão já existente ou em processamento.');
    return;
  }

  ensureAuthFolder(session);
  qrAttempts[session] = 0;
  log(socket, session, '🚀 Inicializando instância do WhatsApp Web...');

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: session }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  clients[session] = client;

  // Recebimento de QR Code
  client.on('qr', qr => {
    qrAttempts[session]++;
    log(socket, session, `📷 QR Code gerado (${qrAttempts[session]}/15)`);
    socket.emit('qr', { session, qr, attempt: qrAttempts[session] });

    if (qrAttempts[session] >= 15) {
      socket.emit('session-ended', { session, reason: 'QR Code expirado' });
      log(socket, session, '❌ Tentativas de QR esgotadas. Finalizando instância.');
      client.destroy();
      delete clients[session];
    }
  });

  // Conexão bem-sucedida
  client.on('ready', async () => {
    log(socket, session, '🔐 Instância conectada e pronta!');
    const authPath = path.join(BASE_AUTH_DIR, `session-${session}`);
    await waitForAuthFolder(authPath, socket, session);

    try {
      if (!client.info) client.info = {};
      client.info.connected = true;

      const accountInfo = await getAccountInfo(client);

      log(socket, session, '📊 Dados do perfil e grupos sincronizados!');
      socket.emit('session-ready', { session, accountInfo });

      // Notifica todos sobre a lista de sessões ativas
      io.emit('update-active-sessions', { sessions: getActiveSessions() });
    } catch (e) {
      log(socket, session, '❌ Erro ao ler informações da conta: ' + e.message);
      socket.emit('session-ready', { session, error: e.message });
    }
  });

  // Evento de Desconexão (Notificação em Tempo Real)
  client.on('disconnected', reason => {
    const errorMsg = `🚨 ATENÇÃO: Sessão "${session}" foi DESCONECTADA! Motivo: ${reason}`;
    console.log(errorMsg);
    
    // Alerta em tempo real a TODOS os navegadores conectados
    io.emit('log', `[ALERTA EM TEMPO REAL] ${errorMsg}`);
    io.emit('session-disconnected-alert', { session, reason });

    if (client.info) client.info.connected = false;
    client.destroy().catch(() => {});
    delete clients[session];

    io.emit('update-active-sessions', { sessions: getActiveSessions() });
  });

  client.initialize().catch(err => {
    log(socket, session, '❌ Erro fatal ao inicializar cliente: ' + err.message);
    delete clients[session];
  });
}

// Configuração do servidor Socket.IO
io.on('connection', socket => {
  // Dispara o log de confirmação de conexão inicial
  log(socket, null, '✅ Conexão Socket estabelecida com sucesso com o servidor!');

  // Envia a lista de sessões ativas atuais
  const active = getActiveSessions();
  socket.emit('update-active-sessions', {
    sessions: active,
    message: active.length === 0 ? 'Nenhuma sessão ativa' : undefined
  });

  // Solicitação para iniciar sessão
  socket.on('start-session', session => {
    if (!session || !session.trim()) {
      return socket.emit('log', '[SISTEMA] ❌ Nome de sessão inválido.');
    }
    startSession(socket, session.trim());
  });

  // Download completo dos dados de sessão em formato ZIP
  socket.on('download-session', async sessionName => {
    if (!sessionName) {
      return socket.emit('log', '[SISTEMA] ❌ Nenhuma sessão informada para download.');
    }

    const authPath = path.join(BASE_AUTH_DIR, `session-${sessionName}`);

    if (!fs.existsSync(authPath)) {
      log(socket, sessionName, `❌ Pasta de autenticação não encontrada no servidor: ${authPath}`);
      return socket.emit('log', `[SISTEMA] ❌ Erro: Dados da sessão "${sessionName}" não existem em disco.`);
    }

    try {
      log(socket, sessionName, '📦 Compactando toda a pasta de credenciais da sessão...');

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
        log(socket, sessionName, '✅ Arquivo ZIP gerado e enviado com sucesso!');
      });

      archive.on('error', err => {
        log(socket, sessionName, '❌ Erro ao compactar pasta ZIP: ' + err.message);
      });

      // Inclui a pasta de autenticação de forma recursiva
      archive.directory(authPath, false);
      await archive.finalize();

    } catch (e) {
      log(socket, sessionName, '❌ Erro na exportação ZIP: ' + e.message);
    }
  });

  // RESTAURAÇÃO: Upload de ZIP para conectar sessão pré-existente
  socket.on('upload-session', async data => {
    const { sessionName, zipBase64 } = data;

    if (!sessionName || !zipBase64) {
      return socket.emit('upload-status', { success: false, message: 'Dados inválidos para upload.' });
    }

    const targetDir = path.join(BASE_AUTH_DIR, `session-${sessionName}`);

    try {
      log(socket, sessionName, '📥 Recebendo e descompactando arquivo de sessão...');

      if (fs.existsSync(targetDir)) {
        fs.rmSync(targetDir, { recursive: true, force: true });
      }
      fs.mkdirSync(targetDir, { recursive: true });

      const zipBuffer = Buffer.from(zipBase64, 'base64');
      
      // Extrai os arquivos para o diretório da sessão
      const directory = await unzipper.Open.buffer(zipBuffer);
      await directory.extract({ path: targetDir });

      log(socket, sessionName, '📁 Arquivos extraídos com sucesso! Validando credenciais...');

      // Cria cliente e tenta conectar
      const client = new Client({
        authStrategy: new LocalAuth({ clientId: sessionName }),
        puppeteer: {
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
      });

      clients[sessionName] = client;

      let isReady = false;

      client.on('ready', async () => {
        isReady = true;
        if (!client.info) client.info = {};
        client.info.connected = true;

        const accountInfo = await getAccountInfo(client);
        log(socket, sessionName, '✅ Sessão VÁLIDA e restaurada com sucesso!');

        socket.emit('upload-status', {
          success: true,
          message: `Sessão "${sessionName}" é válida e foi conectada com sucesso!`
        });

        socket.emit('session-ready', { session: sessionName, accountInfo });
        io.emit('update-active-sessions', { sessions: getActiveSessions() });
      });

      // Se gerar QR code, significa que o token importado expirou ou é inválido
      client.on('qr', () => {
        if (!isReady) {
          log(socket, sessionName, '❌ Sessão INVÁLIDA ou expirada (solicitou QR Code). Limpando dados...');
          client.destroy();
          delete clients[sessionName];

          if (fs.existsSync(targetDir)) {
            fs.rmSync(targetDir, { recursive: true, force: true });
          }

          socket.emit('upload-status', {
            success: false,
            message: 'A sessão enviada é INVÁLIDA ou expirou. Os arquivos foram removidos.'
          });
        }
      });

      client.on('disconnected', reason => {
        const msg = `🚨 ATENÇÃO: Sessão "${sessionName}" foi DESCONECTADA! Motivo: ${reason}`;
        io.emit('log', `[ALERTA EM TEMPO REAL] ${msg}`);
        io.emit('session-disconnected-alert', { session: sessionName, reason });

        if (client.info) client.info.connected = false;
        client.destroy().catch(() => {});
        delete clients[sessionName];

        io.emit('update-active-sessions', { sessions: getActiveSessions() });
      });

      client.initialize().catch(err => {
        log(socket, sessionName, '❌ Falha ao validar sessão enviada: ' + err.message);
        if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
        delete clients[sessionName];
        socket.emit('upload-status', { success: false, message: 'Erro na inicialização: ' + err.message });
      });

    } catch (err) {
      log(socket, sessionName, '❌ Erro ao processar upload do ZIP: ' + err.message);
      if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
      socket.emit('upload-status', { success: false, message: 'Erro ao descompactar o arquivo ZIP.' });
    }
  });

  // Envio de mensagens
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
      log(socket, session, `❌ Falha ao enviar para ${number}: ${e.message}`);
    }
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
