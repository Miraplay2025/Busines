const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { create } = require('@wppconnect-team/wppconnect');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Serve a pasta sessions para que os QR Codes possam ser acessados pelo navegador
app.use('/sessions', express.static(path.join(__dirname, 'sessions')));

const sessions = {};

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
      autoClose: 0, // Não fechar automaticamente
      qrTimeout: 0  // QR Code não expira automaticamente
    });

    sessions[sessionName] = { client, connected: false, qrPath: null };

    // Evento QR Code
    client.onQrCode((base64Qr, asciiQR, attempt, urlCode) => {
      const qrFile = path.join(sessionPath, 'qrcode.png');
      const qrData = base64Qr.replace('data:image/png;base64,', '');
      fs.writeFileSync(qrFile, qrData, 'base64');

      sessions[sessionName].qrPath = `/sessions/${sessionName}/qrcode.png`;
      console.log(`📷 QR Code gerado para sessão ${sessionName} (tente ${attempt})`);
    });

    // Evento de status da sessão
    client.onStateChange((state) => {
      if (state === 'CONNECTED') {
        console.log(`✅ Sessão ${sessionName} conectada com sucesso!`);
        sessions[sessionName].connected = true;
      } else if (state === 'DISCONNECTED') {
        console.log(`⚠️ Sessão ${sessionName} desconectada`);
      }
    });

    res.json({ message: 'Sessão iniciada, aguarde QR Code...', qrPath: sessions[sessionName].qrPath });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao criar sessão' });
  }
});

// Retorna status da sessão e QR Code (para futura atualização se necessário)
app.get('/session/:name', (req, res) => {
  const { name } = req.params;
  const session = sessions[name];
  if (!session) return res.status(404).json({ error: 'Sessão não encontrada' });

  res.json({
    connected: session.connected,
    qrPath: session.qrPath
  });
});

app.listen(3000, () => {
  console.log('Servidor rodando em http://localhost:3000');
});

