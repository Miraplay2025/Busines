  const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { create } = require('@wppconnect-team/wppconnect');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Servir a pasta sessions
app.use('/sessions', express.static(path.join(__dirname, 'sessions')));

const server = http.createServer(app);
const io = new Server(server);

const sessions = {};

// Cria sessão
app.post('/create-session', async (req, res) => {
  const { sessionName } = req.body;
  if (!sessionName) return res.status(400).json({ error: 'Nome da sessão é obrigatório' });

  try {
    const sessionPath = path.join(__dirname, 'sessions', sessionName);
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

    const client = await create({
      session: sessionName,
      headless: true,
      puppeteerOptions: ['--no-sandbox', '--disable-setuid-sandbox'],
      autoClose: 0,
      qrTimeout: 0
    });

    sessions[sessionName] = { client, connected: false, qrPath: null };

    // Evento QR Code
    client.onQrCode((base64Qr, asciiQR, attempt, urlCode) => {
      const qrFile = path.join(sessionPath, 'qrcode.png');
      const qrData = base64Qr.replace('data:image/png;base64,', '');
      fs.writeFileSync(qrFile, qrData, 'base64');

      const qrWebPath = `/sessions/${sessionName}/qrcode.png`;
      sessions[sessionName].qrPath = qrWebPath;

      console.log(`📷 QR Code gerado para sessão ${sessionName} (tente ${attempt})`);

      // Envia QR Code via WebSocket
      io.to(sessionName).emit('qr', { qrPath: qrWebPath, sessionName });
    });

    client.onStateChange((state) => {
      if (state === 'CONNECTED') {
        console.log(`✅ Sessão ${sessionName} conectada com sucesso!`);
        sessions[sessionName].connected = true;
        io.to(sessionName).emit('connected');
      } else if (state === 'DISCONNECTED') {
        console.log(`⚠️ Sessão ${sessionName} desconectada`);
      }
    });

    res.json({ message: 'Sessão iniciada. Aguarde o QR Code...' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao criar sessão' });
  }
});

// Socket.IO
io.on('connection', (socket) => {
  console.log('Cliente conectado ao WebSocket');

  socket.on('joinSession', (sessionName) => {
    socket.join(sessionName);
    console.log(`Cliente entrou na sala da sessão ${sessionName}`);
  });
});

server.listen(3000, () => {
  console.log('Servidor rodando em http://localhost:3000');
});
