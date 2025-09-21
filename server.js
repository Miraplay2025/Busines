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
const steps = [
  "Iniciando sessão...",
  "Inicializando navegador...",
  "Carregando WhatsApp Web...",
  "Página carregada",
  "Injetando wapi.js...",
  "WhatsApp Web carregado",
  "Aguardando leitura do QR Code..."
];

// 🔌 Captura todos os logs do console e envia ao Socket.io
function logStep(sessionName, message, stepIndex = null) {
  console.log(message);
  io.to(sessionName).emit('log', {
    message,
    progress: stepIndex !== null ? Math.round(((stepIndex + 1) / steps.length) * 100) : null
  });
}

// Socket.io
io.on('connection', (socket) => {
  console.log('🔗 Novo cliente conectado');
  socket.on('joinSession', (sessionName) => {
    socket.join(sessionName);
    console.log(`📡 Cliente entrou na sala da sessão: ${sessionName}`);
  });
});

// Criar sessão
app.post('/create-session', async (req, res) => {
  const { sessionName } = req.body;
  if (!sessionName) return res.status(400).json({ error: 'Nome da sessão é obrigatório' });

  try {
    logStep(sessionName, `🚀 Iniciando sessão: ${sessionName}`, 0);

    const client = await create({
      session: sessionName,
      headless: true,
      autoClose: 0,
      qrTimeout: 0,
      catchQR: (qrCode, asciiQR, attempt) => {
        logStep(sessionName, `📷 QR Code recebido (tentativa ${attempt})`, 6);
        QRCode.toDataURL(qrCode).then((qrDataUrl) => {
          io.to(sessionName).emit('qr', { qrDataUrl, sessionName });
        });
      },
      puppeteerOptions: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
      logQR: false
    });

    sessions[sessionName] = { client, connected: false };

    // Eventos principais
    client.onStateChange((state) => {
      logStep(sessionName, `📡 Estado da sessão: ${state}`);
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
