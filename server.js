const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { create } = require('@wppconnect-team/wppconnect');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const sessions = {};

// Socket.io
io.on('connection', (socket) => {
  console.log('🔗 Novo cliente conectado');

  socket.on('joinSession', (sessionName) => {
    console.log(`📡 Cliente entrou na sala da sessão: ${sessionName}`);
    socket.join(sessionName);
  });
});

// Criar sessão
app.post('/create-session', async (req, res) => {
  const { sessionName } = req.body;
  if (!sessionName) return res.status(400).json({ error: 'Nome da sessão é obrigatório' });

  try {
    console.log(`🚀 Iniciando sessão: ${sessionName}`);

    const client = await create({
      session: sessionName,
      headless: true,
      autoClose: 0,
      qrTimeout: 0,
      puppeteerOptions: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
    });

    sessions[sessionName] = { client, connected: false };

    // QR Code
    client.onQrCode(async (qrCode, asciiQR, attempt) => {
      console.log(`📷 QR Code recebido (tentativa ${attempt}) para sessão ${sessionName}`);
      try {
        const qrDataUrl = await QRCode.toDataURL(qrCode); // Gera base64
        io.to(sessionName).emit('qr', { qrDataUrl, sessionName });
      } catch (err) {
        console.error(`❌ Erro ao gerar QR base64:`, err);
      }
    });

    // Estado da sessão
    client.onStateChange((state) => {
      console.log(`📡 Estado da sessão ${sessionName}: ${state}`);
      if (state === 'CONNECTED') {
        sessions[sessionName].connected = true;
        io.to(sessionName).emit('connected');
      } else if (state === 'DISCONNECTED') {
        sessions[sessionName].connected = false;
        io.to(sessionName).emit('disconnected');
      }
    });

    res.json({ success: true, message: `Sessão ${sessionName} criada, aguardando QR Code...` });
  } catch (err) {
    console.error(`❌ Erro ao criar sessão ${sessionName}:`, err);
    res.status(500).json({ error: 'Erro ao criar sessão', details: err.message });
  }
});

// Página inicial
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// Inicializar servidor
server.listen(3000, () => {
  console.log('🌍 Servidor rodando em http://localhost:3000');
});
