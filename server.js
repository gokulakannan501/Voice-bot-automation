require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
// ---------------------------------------------------------
// REAL-TIME DASHBOARD LOG STREAMING (SSE)
// ---------------------------------------------------------
const sseClients = new Set();

// Intercept console.log to broadcast internal engine logs to the dashboard
const originalConsoleLog = console.log;
console.log = function (...args) {
    const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
    originalConsoleLog(message);

    const sseMessage = message.split('\n').map(line => `data: ${line}`).join('\n') + '\n\n';

    // Broadcast to dashboard without crashing if a write fails
    sseClients.forEach(client => {
        try {
            client.write(sseMessage);
        } catch (err) {
            // Quietly ignore failed writes to disconnected clients
        }
    });
};

const originalConsoleError = console.error;
console.error = function (...args) {
    const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
    originalConsoleError(message);

    const sseMessage = message.split('\n').map(line => `data: ❌ ERROR: ${line}`).join('\n') + '\n\n';
    sseClients.forEach(client => {
        try {
            client.write(sseMessage);
        } catch (err) { }
    });
};

const callManager = require('./engine/callManager');
const chatManager = require('./engine/chatManager');
const { spawn } = require('child_process');
const twilio = require('twilio');
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

app.use(express.json());

// Standard Webhook Route from Exotel
const path = require('path');

// Serve the OTP Injection Dashboard HTML file
app.use(express.static(path.join(__dirname, 'public')));

// Exotel Webhook (Legacy)
app.post('/webhook', (req, res) => {
    res.sendStatus(200);
});

// Twilio TwiML Webhook (Fired when the target answers the call)
app.post('/twilio-webhook', (req, res) => {
    const requestedLanguage = req.query.language || 'English';
    const persona = req.query.persona || 'Self';

    console.log(`\n📞 [Twilio] Target answered! Lang: ${requestedLanguage}, Persona: ${persona}.`);

    // We need the absolute wss:// version of our current host URL
    // Use environment variable for host if available, else fallback safely
    let host = req.headers.host;
    if (process.env.PUBLIC_URL) {
        // Strip out the protocol and any trailing slashes to get just the host portion for the wss:// prefix
        host = process.env.PUBLIC_URL.replace(/^https?:\/\//, '').replace(/\/$/, '');
    }
    const wssUrl = `wss://${host}/`;

    // Use Twilio's XML builder to prevent injection vulnerabilities
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();
    const connect = response.connect();
    const stream = connect.stream({ url: wssUrl });

    stream.parameter({ name: 'targetLanguage', value: requestedLanguage });
    stream.parameter({ name: 'persona', value: persona });

    res.type('text/xml');
    res.send(response.toString());
});

// Manual OTP Injection Route (Triggered from Dashboard)
app.post('/inject-otp', (req, res) => {
    const otpCode = req.body.otp;

    if (otpCode) {
        console.log(`\n💉 [Manual Injection] User injected OTP: ${otpCode}`);
        // Store it globally so the LLM knows it instantly
        callManager.latestReceivedOTP = otpCode;
        chatManager.latestReceivedOTP = otpCode; // Sync to chat manager too
        res.sendStatus(200);
    } else {
        res.status(400).send("No OTP provided");
    }
});

// SSE Endpoint for Dashboard Log Stream
app.get('/logs-stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    sseClients.add(res);

    req.on('close', () => {
        sseClients.delete(res);
    });
});

// Manual Response Override Route (Triggered from Dashboard)
app.post('/override-response', (req, res) => {
    const overrideText = req.body.text;

    if (overrideText) {
        console.log(`\n🎛️ [Manual Override] User set NEXT AI response: "${overrideText}"`);
        callManager.manualOverrideResponse = overrideText;
        chatManager.manualOverrideResponse = overrideText; // Sync to chat manager too
        res.sendStatus(200);
    } else {
        res.status(400).send("No text provided");
    }
});

// Trigger Twilio Call Endpoint (From Dashboard)
app.post('/run-test', (req, res) => {
    const requestedLanguage = req.body.language || 'English';
    const persona = req.body.persona || 'Self';

    console.log(`\n> Dashboard triggered new Twilio outbound test. Lang: ${requestedLanguage}, Persona: ${persona}`);

    // Spawn the Twilio dialer script as a background process with parameters
    const child = spawn('node', ['test_call_twilio.js', requestedLanguage, persona]);

    child.on('error', (err) => {
        console.error(`❌ [Server] Failed to start test_call_twilio.js: ${err.message}`);
    });

    child.on('exit', (code) => {
        if (code !== 0) {
            console.error(`❌ [Server] test_call_twilio.js exited with code ${code}`);
        } else {
            console.log(`✅ [Server] test_call_twilio.js finished successfully.`);
        }
    });

    // Pipe the Twilio dialer output into our Server Console so it broadcasts to the UI
    child.stdout.on('data', (data) => {
        const lines = data.toString().split('\n').filter(line => line.trim());
        lines.forEach(line => console.log(line));
    });

    child.stderr.on('data', (data) => {
        const lines = data.toString().split('\n').filter(line => line.trim());
        lines.forEach(line => console.error(line));
    });

    res.sendStatus(200);
});

// Trigger WhatsApp Test Endpoint (From Dashboard)
app.post('/run-whatsapp-test', async (req, res) => {
    const requestedLanguage = req.body.language || 'English';
    const persona = req.body.persona || 'Self';
    const formattedTarget = process.env.WHATSAPP_BOT_NUMBER;

    if (!formattedTarget || formattedTarget.includes('x')) {
        console.error("❌ [Server] WHATSAPP_BOT_NUMBER is not set correctly in .env");
        return res.status(400).send("WhatsApp Bot Number not configured.");
    }

    console.log(`\n> Dashboard triggered new WhatsApp session. Target: ${formattedTarget} | Lang: ${requestedLanguage} | Persona: ${persona}`);

    // Initialize and send first message
    chatManager.startChat(formattedTarget, 'BOOKING', requestedLanguage, persona);
    await chatManager.sendInitialMessage(formattedTarget);

    res.sendStatus(200);
});

// Twilio WhatsApp Webhook Endpoint
app.post('/whatsapp-webhook', async (req, res) => {
    const incomingText = req.body.Body;
    const from = req.body.From;

    if (incomingText) {
        // console.log(`\n💬 [Twilio WhatsApp] Incoming message from ${from}: "${incomingText}"`);
        await chatManager.handleIncomingMessage(from, incomingText);
    }

    res.sendStatus(200);
});

// End an active Twilio Call Endpoint (From Dashboard)
app.post('/end-test', async (req, res) => {
    console.log(`\n> Dashboard requested to end active calls...`);
    const activeCalls = [...callManager.activeCalls.keys()];

    if (activeCalls.length === 0) {
        console.log(`> No active calls found in CallManager.`);
        return res.sendStatus(200);
    }

    try {
        for (const sid of activeCalls) {
            console.log(`> Terminating Twilio Call SID: ${sid}`);
            await twilioClient.calls(sid).update({ status: 'completed' });
            callManager.endCall(sid);
        }
        res.sendStatus(200);
    } catch (e) {
        console.error(`> Error terminating call:`, e.message);
        res.status(500).send(e.message);
    }
});

const WaveFile = require('wavefile').WaveFile;

// WebSocket Route from Twilio Media Streams
wss.on('connection', (ws) => {
    console.log('🎧 Twilio WebSocket Audio Stream Connected');
    let callSid = "test-call-" + Date.now(); // Fallback
    let streamSid = null;

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message.toString());
            const eventType = data.event;

            if (eventType === 'start') {
                ws.streamSid = data.streamSid; // Bind it directly to the connection object
                callSid = data.start.callSid;
                const customParams = data.start.customParameters || {};
                console.log(`\n\n📡 Twilio Stream Started! Call SID: ${callSid} | Params:`, customParams);

                // Explicitly start the call in our engine, inheriting the UI language requested
                callManager.startCall(callSid, ws, customParams);
                return;
            }

            // Extract Base64 Audio if present
            if (eventType === 'media' && data.media && data.media.payload) {
                // Twilio sends 8kHz mu-law encoded audio in base64
                const mulawAudioBuffer = Buffer.from(data.media.payload, 'base64');

                // Sarvam requires 16-bit PCM. We use wavefile to quickly transcode it.
                // 1. Create a WAV file object containing the mu-law bytes
                const wav = new WaveFile();
                wav.fromScratch(1, 8000, '8m', mulawAudioBuffer); // 1 channel, 8000hz, 8-bit mu-law

                // 2. Transcode the WAV object into 16-bit PCM
                wav.fromMuLaw();

                // 3. Extract the raw PCM bytes (ignoring the WAV headers since Sarvam accepts raw PCM)
                const pcmSamples = wav.getSamples(false, Int16Array);
                const pcmAudioBuffer = Buffer.from(pcmSamples.buffer);

                // 4. Compute RMS Volume for Voice Activity Detection (VAD)
                let sumSquares = 0;
                for (let i = 0; i < pcmSamples.length; i++) {
                    sumSquares += pcmSamples[i] * pcmSamples[i];
                }
                const rms = Math.sqrt(sumSquares / pcmSamples.length);

                // Pass the transcoded PCM bytes AND the volume to the Call Manager
                await callManager.handleIncomingAudio(callSid, pcmAudioBuffer, ws, rms);
            }

            if (eventType === 'stop') {
                console.log('🛑 Twilio stream stopped by remote.');
                await callManager.endCall(callSid);
            }
        } catch (e) {
            console.error('Error parsing WebSocket message from Twilio:', e.message);
        }
    });

    ws.on('close', async () => {
        console.log('Twilio WebSocket Disconnected physically');
        await callManager.endCall(callSid);
    });
});

const PORT = process.env.PORT || 4001;
server.listen(PORT, () => {
    console.log(`🚀 Exotel Native Webhook & WebSocket Server running on port ${PORT}`);
});
