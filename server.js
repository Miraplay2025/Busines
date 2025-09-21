const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { create } = require('@wppconnect-team/wppconnect');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cors());
app.use(express.json());
app.use(express.static('sessions'));

const sessions = {};

// Socket.io - conexão
io.on('connection', (socket) => {
  console.log('🔗 Novo cliente conectado');

  socket.on('joinSession', (sessionName) => {
    console.log(`📡 Cliente entrou na sala da sessão: ${sessionName}`);
    socket.join(sessionName);
  });
});

// Rota para criar sessão
app.post('/create-session', async (req, res) => {
  const { sessionName } = req.body;
  if (!sessionName) {
    return res.status(400).json({ error: 'Nome da sessão é obrigatório' });
  }

  try {
    console.log(`🚀 Iniciando sessão: ${sessionName}`);
    const sessionPath = path.join(__dirname, 'sessions', sessionName);

    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

    const client = await create({
      session: sessionName,
      headless: true,
      autoClose: 0,
      qrTimeout: 0,
      puppeteerOptions: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      },
    });

    console.log(`✅ Cliente criado para sessão: ${sessionName}`);
    sessions[sessionName] = { client, connected: false, qrPath: null };

    // Evento QR Code
    client.onQrCode((base64Qr, asciiQR, attempt, urlCode) => {
      console.log(`📷 QR Code recebido (tentativa ${attempt}) para sessão ${sessionName}`);

      const qrFile = path.join(sessionPath, 'qrcode.png');
      const qrData = base64Qr.replace('data:image/png;base64,', '');
      fs.writeFileSync(qrFile, qrData, 'base64');

      const qrPath = `/sessions/${sessionName}/qrcode.png`;
      sessions[sessionName].qrPath = qrPath;

      io.to(sessionName).emit('qr', { qrPath, sessionName });
    });

    // Evento estado da sessão
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

    res.json({ success: true, message: `Sessão ${sessionName} criada, aguarde o QR Code...` });
  } catch (err) {
    console.error(`❌ Erro ao criar sessão ${sessionName}:`, err);
    res.status(500).json({ error: 'Erro ao criar sessão', details: err.message });
  }
});

// Inicializa servidor
server.listen(3000, () => {
  console.log('🌍 Servidor rodando em http://localhost:3000');
});
