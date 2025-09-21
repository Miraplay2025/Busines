const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { create } = require('@wppconnect-team/wppconnect');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sessions = {};

// Função para enviar logs e progresso para o front-end
function logStep(sessionName, message, progress = null) {
  console.log(`[${sessionName}] ${message}`);
  io.to(sessionName).emit('log', { message, progress });
}

// Socket.io
io.on('connection', (socket) => {
  console.log('🔗 Novo cliente conectado');
  socket.on('joinSession', (sessionName) => {
    socket.join(sessionName);
    logStep(sessionName, '📡 Cliente entrou na sala da sessão');
  });
});

// Criar sessão
app.post('/create-session', async (req, res) => {
  const { sessionName } = req.body;
  if (!sessionName) return res.status(400).json({ error: 'Nome da sessão é obrigatório' });

  try {
    logStep(sessionName, `🚀 Criando sessão: ${sessionName}`, 0);

    // Pasta exclusiva por sessão para evitar conflitos
    const sessionDir = path.join('/tmp', `wppconnect-${sessionName}-${Date.now()}`);
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
    logStep(sessionName, `📁 Diretório da sessão criado: ${sessionDir}`, 5);

    const client = await create({
      session: sessionName,
      sessionDataPath: sessionDir,  // Pasta separada por sessão
      headless: true,
      autoClose: 0,                 // Mantém o processo vivo
      qrTimeout: 0,                 // QR não expira
      killProcessOnBrowserClose: false,
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
      disableSpins: true,
      logQR: false,
      catchQR: async (qrCode, asciiQR, attempt) => {
        try {
          logStep(sessionName, `📷 QR Code recebido (tentativa ${attempt})`, 70);

          // Converter para Data URL usando qrcode
          const QRCodeLib = require('qrcode');
          const qrDataUrl = await QRCodeLib.toDataURL(qrCode, { errorCorrectionLevel: 'H' });

          io.to(sessionName).emit('qr', { qrDataUrl, sessionName });
        } catch (err) {
          logStep(sessionName, `❌ Erro ao gerar QR Code: ${err.message}`);
        }
      }
    });

    sessions[sessionName] = { client, connected: false };
    logStep(sessionName, '✅ Cliente WPPConnect inicializado', 80);

    // Eventos de estado
    client.onStateChange(state => {
      logStep(sessionName, `📡 Estado da sessão: ${state}`);
      if (state === 'CONNECTED') {
        sessions[sessionName].connected = true;
        io.to(sessionName).emit('connected');
        logStep(sessionName, '✅ Sessão conectada', 100);
      } else if (state === 'DISCONNECTED') {
        sessions[sessionName].connected = false;
        io.to(sessionName).emit('disconnected');
        logStep(sessionName, '⚠️ Sessão desconectada', 0);
      } else if (state === 'QRCODE') {
        logStep(sessionName, '🔄 QR Code expirou, gerando novo...');
      }
    });

    // Keep-alive: mantém o Node e Puppeteer vivo
    setInterval(() => {
      logStep(sessionName, '🟢 Sessão ativa (keep-alive)');
    }, 60000);

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

// Inicializar servidor
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`🌍 Servidor rodando em http://localhost:${PORT}`));
