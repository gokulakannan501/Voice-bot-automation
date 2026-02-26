require('dotenv').config();
const twilio = require('twilio');

// Load API Keys from .env
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioNumber = process.env.TWILIO_PHONE_NUMBER;
let targetBotNumber = process.env.TARGET_BOT_NUMBER;

// Ensure E.164 format (India +91) for Twilio
if (targetBotNumber.startsWith('0')) {
    targetBotNumber = '+91' + targetBotNumber.substring(1);
} else if (targetBotNumber.length === 10) {
    targetBotNumber = '+91' + targetBotNumber;
}

// Initialize Twilio Client
const client = twilio(accountSid, authToken);

// We assume Ngrok is running on port 4040 to grab the public URL automatically
const axios = require('axios');

async function startTwilioCall() {
    try {
        console.log(`\n🎧 Initiating Twilio Call to Target Bot => ${targetBotNumber}...`);

        // 1. Ask local Ngrok for its public forwarding URL
        let ngrokUrl = "";
        try {
            const ngrokRes = await axios.get("http://127.0.0.1:4040/api/tunnels");
            ngrokUrl = ngrokRes.data.tunnels[0].public_url;
            console.log(`🔗 Found Ngrok Tunnel: ${ngrokUrl}`);
        } catch (err) {
            console.error("\n❌ ERROR: Could not find Ngrok. Make sure `ngrok http 4001` is running!");
            return;
        }

        // 2. Instruct Twilio to dial the number
        const call = await client.calls.create({
            url: `${ngrokUrl}/twilio-webhook`, // Twilio will POST to this URL when the call is answered
            to: targetBotNumber,
            from: twilioNumber
        });

        console.log("✅ Call successfully initiated!");
        console.log(`Call SID: ${call.sid}\n`);
        console.log("Make sure your `node server.js` is running!");
        console.log("Twilio will now ring the target bot, and POST to your webhook for instructions.");

    } catch (error) {
        console.error("❌ Failed to initiate Twilio call:", error.message);
    }
}

startTwilioCall();
