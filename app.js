const { Client, MessageMedia, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const { body, validationResult } = require('express-validator');
const socketIO = require('socket.io');
const qrcode = require('qrcode');
const http = require('http');
const fs = require('fs');
const { phoneNumberFormatter } = require('./helpers/formatter');
const fileUpload = require('express-fileupload');
const axios = require('axios');
const { contentType } = require('mime-types');
const port = process.env.PORT || 8000;

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(express.json());
app.use(express.urlencoded({
  extended: true
}));

/**
 * BASED ON MANY QUESTIONS
 * Actually ready mentioned on the tutorials
 * 
 * The two middlewares above only handle for data json & urlencode (x-www-form-urlencoded)
 * So, we need to add extra middleware to handle form-data
 * Here we can use express-fileupload
 */
app.use(fileUpload({
  debug: false
}));

app.get('/', (req, res) => {
  res.sendFile('index-multiple-account.html', {
    root: __dirname
  });
});

app.get('/funcao', (req, res) => {
  res.sendFile('Whatsapp_web_chat_template.html', {
    root: __dirname
  });
});

const sessions = [];
const SESSIONS_FILE = './whatsapp-sessions.json';

const createSessionsFileIfNotExists = function() {
  if (!fs.existsSync(SESSIONS_FILE)) {
    try {
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify([]));
      console.log('Sessions file created successfully.');
    } catch(err) {
      console.log('Failed to create sessions file: ', err);
    }
  }
}

createSessionsFileIfNotExists();

const setSessionsFile = function(sessions) {
  fs.writeFile(SESSIONS_FILE, JSON.stringify(sessions), function(err) {
    if (err) {
      console.log(err);
    }
  });
}

const getSessionsFile = function() {
  return JSON.parse(fs.readFileSync(SESSIONS_FILE));
}

const createSession = async function(id, description, webhooks) {

  var retorno = "";

  console.log('Creating session: ' + id);
  const client = new Client({
    restartOnAuthFail: true,
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process', // <- this one doesn't works in Windows
        '--disable-gpu'
      ],
    },
    authStrategy: new LocalAuth({
      clientId: id
    })
  });

  client.initialize();

  await client.on('qr', async (qr) => {
    console.log('QR RECEIVED', qr);
    await qrcode.toDataURL(qr, (err, url) => {
      io.emit('qr', { id: id, src: url });
      io.emit('message', { id: id, text: 'QR Code received, scan please!' });
      
      fetch(sessions[0].webhooks,{
        method: 'POST',
        headers: {
          'content-Type': 'application/json',
        },
        body: JSON.stringify({
          'type': 'authentication',
          'clientId': client.options.authStrategy.clientId,
          'qrcode': url
        })
      }).then(() => {

      }).catch((err) => console.log(err))
      retorno = url;
    });
  });

  await client.on('ready', () => {
    io.emit('ready', { id: id });
    io.emit('message', { id: id, text: 'Whatsapp is ready!' });

    fetch("https://webhook.site/5b89996e-13d9-4705-9d8a-beb2350d91b5",{
        method: 'POST',
        headers: {
          'content-Type': 'application/json',
        },
        body: JSON.stringify({
          'type': 'authentication',
          'clientId': client.options.authStrategy.clientId,
          'message': 'whatsapp is ready!'
        })
      }).then(() => {

      }).catch((err) => console.log(err))

    retorno = 'Whatsapp is ready!';

    const savedSessions = getSessionsFile();
    const sessionIndex = savedSessions.findIndex(sess => sess.id == id);
    savedSessions[sessionIndex].ready = true;
    setSessionsFile(savedSessions);
  });

  await client.on('authenticated', () => {
    io.emit('authenticated', { id: id });
    io.emit('message', { id: id, text: 'Whatsapp is authenticated!' });
    retorno = 'Whatsapp is authenticated!';
  });

  await client.on('auth_failure', function() {
    io.emit('message', { id: id, text: 'Auth failure, restarting...' });
    retorno = 'Auth failure, restarting...';
  });

  await client.on('disconnected', (reason) => {
    io.emit('message', { id: id, text: 'Whatsapp is disconnected!' });
    retorno = 'Whatsapp is disconnected!';
    client.destroy();
    client.initialize();

    // Menghapus pada file sessions
    const savedSessions = getSessionsFile();
    const sessionIndex = savedSessions.findIndex(sess => sess.id == id);
    savedSessions.splice(sessionIndex, 1);
    setSessionsFile(savedSessions);

    io.emit('remove-session', id);
  });

  client.on('message', async msg => {

    const contacts = await client.getChats();
    console.log(contacts)
    fetch("https://webhook.site/5b89996e-13d9-4705-9d8a-beb2350d91b5",{
        method: 'POST',
        headers: {
          'content-Type': 'application/json',
        },
        body: JSON.stringify({
          'type': 'message',
          'clientId': client.options.authStrategy.clientId,
          'data': msg
        })
      }).then(() => {

      }).catch((err) => console.log(err))
  });

  // Tambahkan client ke sessions
  sessions.push({
    id: id,
    description: description,
    webhooks: webhooks,
    client: client
  });

  // Menambahkan session ke file
  const savedSessions = getSessionsFile();
  const sessionIndex = savedSessions.findIndex(sess => sess.id == id);

  if (sessionIndex == -1) {
    savedSessions.push({
      id: id,
      description: description,
      webhooks: webhooks,
      ready: false,
    });
    setSessionsFile(savedSessions);
  }

  return await Promise.resolve(retorno);
}

const init = function(socket) {
  const savedSessions = getSessionsFile();

  if (savedSessions.length > 0) {
    if (socket) {
      /**
       * At the first time of running (e.g. restarting the server), our client is not ready yet!
       * It will need several time to authenticating.
       * 
       * So to make people not confused for the 'ready' status
       * We need to make it as FALSE for this condition
       */
      savedSessions.forEach((e, i, arr) => {
        arr[i].ready = false;
      });

      socket.emit('init', savedSessions);
    } else {
      savedSessions.forEach(sess => {
        createSession(sess.id, sess.description, sess.webhooks);
      });
    }
  }
}

init();

// Socket IO
io.on('connection', function(socket) {
  init(socket);

  socket.on('create-session', function(data) {
    console.log('Create session: ' + data.id);
    createSession(data.id, data.description);
  });
});

// Send message
app.post('/send-message', async (req, res) => {
  console.log(req);

  const sender = req.body.sender;
  const number = phoneNumberFormatter(req.body.number);
  const message = req.body.message;

  const client = sessions.find(sess => sess.id == sender)?.client;

  console.log(client);

  // Make sure the sender is exists & ready
  if (!client) {
    return res.status(422).json({
      status: false,
      message: `The sender: ${sender} is not found!`
    })
  }

  /**
   * Check if the number is already registered
   * Copied from app.js
   * 
   * Please check app.js for more validations example
   * You can add the same here!
   */
  const isRegisteredNumber = await client.isRegisteredUser(number);

  if (!isRegisteredNumber) {
    return res.status(422).json({
      status: false,
      message: 'The number is not registered'
    });
  }

  client.sendMessage(number, message).then(response => {
    res.status(200).json({
      status: true,
      response: response
    });
  }).catch(err => {
    res.status(500).json({
      status: false,
      response: err
    });
  });
});

app.post('/newdevice',[
  body('token').notEmpty(),
  body('description').notEmpty(),
  body('webhooks').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req).formatWith(({
    res
  }) => {
    return res;
  });

  if (!errors.isEmpty()) {
    return res.status(422).json({
      status: false,
      message: errors.mapped()
    });
  }
  console.log(req);

  const token = req.body.token;
  const description = req.body.description;
  const webhooks = req.body.webhooks;

  createSession(token, description, webhooks)

  res.status(200).json({
        status: true,
        response: "instancia iniciada!"
      })

  

  

  
});

app.post('/getchats',[
  body('token').notEmpty(),
  body('description').notEmpty(),
  body('webhooks').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req).formatWith(({
    res
  }) => {
    return res;
  });

  if (!errors.isEmpty()) {
    return res.status(422).json({
      status: false,
      message: errors.mapped()
    });
  }
  console.log(req);

  const token = req.body.token;
  const description = req.body.description;
  const webhooks = req.body.webhooks;

  const client = sessions.find(sess => sess.id == token)?.client;

  console.log(client);

  // Make sure the sender is exists & ready
  if (!client) {
    return res.status(422).json({
      status: false,
      message: `The sender: ${token} is not found!`
    })
  }

  const chats = await client.getChats();

  io.emit('chats', { data: chats });

  fetch("https://webhook.site/5b89996e-13d9-4705-9d8a-beb2350d91b5",{
        method: 'POST',
        headers: {
          'content-Type': 'application/json',
        },
        body: JSON.stringify({
          'type': 'message',
          'clientId': client.options.authStrategy.clientId,
          'data': chats
        })
      }).then(() => {

      }).catch((err) => console.log(err))

  res.status(200).json({
        status: true,
        response: "instancia iniciada!"
      })

});

server.listen(port, function() {
  console.log('App running on *: ' + port);
});
