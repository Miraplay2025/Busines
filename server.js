const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { create } = require('@wppconnect-team/wppconnect');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sessions = [];
const steps = [
  "Iniciando sessão...",
  "Inicializando navegador...",
  "Carregando WhatsApp Web...",
  "Página carregada",
  "Injetando wapi.js...",
  "WhatsApp Web carregado",
  "Aguardando leitura do QR Code..."
];

// 🔌 Função de log
function logStep(sessionName, message, stepIndex = null) {
  console.log(`[${sessionName}] ${message}`);
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
    logStep(sessionName, `🚀 Criando sessão: ${sessionName}`, 0);

    // Gerar pasta temporária para sessão
    const sessionDir = path.join('/tmp', `wppconnect-${sessionName}`);
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

    const client = await create({
      session: sessionName,
      sessionDataPath: sessionDir,   // Pasta exclusiva para evitar conflito
      headless: true,
      autoClose: 0,
      qrTimeout: 0,
      killProcessOnBrowserClose: true, // Fecha navegador anterior
      catchQR: (qrCode, asciiQR, attempt) => {
        logStep(sessionName, `📷 QR Code recebido (tentativa ${attempt})`, 6);
        QRCode.toDataURL(qrCode).then(qrDataUrl => {
          io.to(sessionName).emit('qr', { qrDataUrl, sessionName });
        }).catch(err => logStep(sessionName, `❌ Erro ao gerar QR Code: ${err}`));
      },
      puppeteerOptions: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-extensions',
          '--disable-gpu'
        ]
      },
      logQR: false,
      disableSpins: true
    });

    sessions.push({ sessionName, client, connected: false });

    client.onStateChange(state => {
      logStep(sessionName, `📡 Estado da sessão: ${state}`);
      if (state === 'CONNECTED') {
        io.to(sessionName).emit('connected');
      } else if (state === 'DISCONNECTED') {
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
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

// Keep-alive
setInterval(() => console.log('🟢 Keep-alive'), 60000);

// Inicializar servidor
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🌍 Servidor rodando em http://localhost:${PORT}`);
});
