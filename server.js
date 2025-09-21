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
app.use(express.static('public'));

const sessions = {};

// Criar sessão
app.post('/create-session', async (req, res) => {
  const { sessionName } = req.body;
  if (!sessionName) return res.status(400).json({ error: 'Nome da sessão é obrigatório' });

  try {
    const sessionPath = path.join(__dirname, 'sessions', sessionName);
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

    const client = await create({
      session: sessionName,
      headless: true,
      puppeteerOptions: {
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
      autoClose: 0,
      qrTimeout: 0
    });

    sessions[sessionName] = { client, connected: false, qrPath: null };

    // Evento de QR Code
    client.onQrCode((base64Qr, asciiQR, attempt, urlCode) => {
      const qrFile = path.join(sessionPath, 'qrcode.png');
      const qrData = base64Qr.replace('data:image/png;base64,', '');
      fs.writeFileSync(qrFile, qrData, 'base64');

      const qrPath = `/sessions/${sessionName}/qrcode.png`;
      sessions[sessionName].qrPath = qrPath;

      console.log(`📷 QR Code gerado para sessão ${sessionName} (tentativa ${attempt})`);

      // Envia para o front pelo socket
      io.emit('qrCode', {
        session: sessionName,
        qrPath,
        message: `📷 Escaneie o QR Code - ${sessionName}.png`
      });
    });

    // Evento de status
    client.onStateChange((state) => {
      if (state === 'CONNECTED') {
        console.log(`✅ Sessão ${sessionName} conectada com sucesso!`);
        sessions[sessionName].connected = true;
        io.emit('sessionConnected', { session: sessionName });
      } else if (state === 'DISCONNECTED') {
        console.log(`⚠️ Sessão ${sessionName} desconectada`);
        sessions[sessionName].connected = false;
        io.emit('sessionDisconnected', { session: sessionName });
      }
    });

    res.json({ success: true, message: 'Sessão iniciada, aguarde QR Code...' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao criar sessão', details: err.message });
  }
});

// Retornar status da sessão
app.get('/session/:name', (req, res) => {
  const { name } = req.params;
  const session = sessions[name];
  if (!session) return res.status(404).json({ error: 'Sessão não encontrada' });

  res.json({
    connected: session.connected,
    qrPath: session.qrPath
  });
});

server.listen(3000, () => {
  console.log('🚀 Servidor rodando em http://localhost:3000');
});

