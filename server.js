require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const callManager = require('./engine/callManager');
const { spawn } = require('child_process');
const twilio = require('twilio');
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ---------------------------------------------------------
// REAL-TIME DASHBOARD LOG STREAMING (SSE)
// ---------------------------------------------------------
const sseClients = new Set();

// Intercept console.log to broadcast internal engine logs to the dashboard
const originalConsoleLog = console.log;
console.log = function (...args) {
    const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
    originalConsoleLog(message); // Still print to terminal

    sseClients.forEach(client => {
        client.write(`data: ${message}\n\n`);
    });
};

const originalConsoleError = console.error;
console.error = function (...args) {
    const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
    originalConsoleError(message);

    sseClients.forEach(client => {
        client.write(`data: ❌ ERROR: ${message}\n\n`);
    });
};

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
    console.log(`\n📞 [Twilio] Target answered! Sending TwiML Stream instructions...`);

    // We need the absolute wss:// version of our current host URL
    const host = req.headers.host;
    const wssUrl = `wss://${host}/`;

    const twiml = `
        <Response>
            <Connect>
                <Stream url="${wssUrl}" />
            </Connect>
        </Response>
    `;

    res.type('text/xml');
    res.send(twiml);
});

// Manual OTP Injection Route (Triggered from Dashboard)
app.post('/inject-otp', (req, res) => {
    const otpCode = req.body.otp;

    if (otpCode) {
        console.log(`\n💉 [Manual Injection] User injected OTP: ${otpCode}`);
        // Store it globally so the LLM knows it instantly
        callManager.latestReceivedOTP = otpCode;
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

// Trigger Twilio Call Endpoint (From Dashboard)
app.post('/run-test', (req, res) => {
    console.log(`\n> Dashboard triggered new Twilio outbound test...`);

    // Spawn the Twilio dialer script as a background process
    const child = spawn('node', ['test_call_twilio.js']);

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
                console.log(`\n\n📡 Twilio Stream Started! Call SID: ${callSid}`);

                // Explicitly start the call in our engine
                callManager.startCall(callSid);
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
