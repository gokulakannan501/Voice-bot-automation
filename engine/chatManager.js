const llmService = require('../services/llmService');
const twilio = require('twilio');

class ChatManager {
    constructor() {
        this.activeChats = new Map();
        this.twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        this.twilioNumber = process.env.TWILIO_WHATSAPP_NUMBER || `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`;
    }

    /**
     * Resets or starts a new chat session
     * @param {string} from - Sender's WhatsApp number
     * @param {string} scenario - "BOOKING" or "CANCELLATION"
     * @param {string} language - Target language
     * @param {string} persona - Persona name
     */
    startChat(from, scenario, language, persona = 'Self') {
        console.log(`💬 [Chat Manager] Initializing new WhatsApp session for ${from} | Scenario: ${scenario} | Lang: ${language}`);

        const symptomOptions = ['fever', 'severe headache', 'stomach ache', 'lower back pain', 'persistent cough', 'sore throat', 'knee pain', 'body fatigue', 'skin rash', 'mild chest pain'];
        const randomSymptom = symptomOptions[Math.floor(Math.random() * symptomOptions.length)];

        this.activeChats.set(from, {
            history: [],
            scenario: scenario,
            targetLanguage: language,
            persona: persona,
            symptom: randomSymptom,
            startTime: Date.now(),
            lastMessageSentAt: null,
            latencies: [],
            isEnding: false
        });
    }

    /**
     * Handles an incoming WhatsApp message
     */
    async handleIncomingMessage(from, text) {
        const chatState = this.activeChats.get(from);
        if (!chatState || chatState.isEnding) {
            console.log(`⚠️ [Chat Manager] Received message for untracked session: ${from}. Ignoring.`);
            return;
        }

        console.log(`🤖 [Target Bot]: "${text}"`);

        // --- LATENCY TRACKING ---
        if (chatState.lastMessageSentAt) {
            const latency = (Date.now() - chatState.lastMessageSentAt) / 1000;
            console.log(`[Chat Manager] Bot responded in ${latency.toFixed(2)}s`);
            chatState.latencies.push(latency);
            chatState.lastMessageSentAt = null;
        }

        chatState.history.push({ role: "user", content: text });

        try {
            // Process with LLM
            const result = await llmService.processCustomerIntent(text, chatState);
            const replyText = result.replyText;

            if (replyText === "END_CALL_LOOP" || text.toLowerCase().includes("thank you")) {
                chatState.isEnding = true;
                await this.sendWhatsApp(from, "The test has concluded. Thank you.");
                await this.endChat(from);
                return;
            }

            if (replyText === "WAIT") return; // Should not really happen in chat, but for safety

            chatState.history.push({ role: "assistant", content: replyText });
            await this.sendWhatsApp(from, replyText);

            chatState.lastMessageSentAt = Date.now();
        } catch (error) {
            console.error(`❌ [Chat Manager] Error processing message: ${error.message}`);
        }
    }

    /**
     * Sends the first message to initiate the conversation
     */
    async sendInitialMessage(from) {
        const chatState = this.activeChats.get(from);
        if (!chatState) return;

        // Force LLM to generate a greeting based on internal rules
        const result = await llmService.processCustomerIntent("(System: Start the chat naturally)", chatState);
        const greeting = result.replyText;

        console.log(`🧑 [AI Tester]: "${greeting}"`);
        chatState.history.push({ role: "assistant", content: greeting });
        await this.sendWhatsApp(from, greeting);
        chatState.lastMessageSentAt = Date.now();
    }

    /**
     * Sends a WhatsApp message via Twilio API
     */
    async sendWhatsApp(to, body) {
        try {
            console.log(`🧑 [AI Tester]: "${body}"`);
            await this.twilioClient.messages.create({
                body: body,
                from: this.twilioNumber,
                to: to
            });
        } catch (error) {
            console.error(`❌ [Twilio WhatsApp] Send Error: ${error.message}`);
        }
    }

    /**
     * Ends the chat and generates a report
     */
    async endChat(from) {
        const chatState = this.activeChats.get(from);
        if (!chatState) return;

        console.log(`📊 [Chat Manager] Analyzing chat history for ${from}...`);

        try {
            const report = await llmService.generateTestReport(chatState);
            console.log(`###REPORT###` + JSON.stringify({ callSid: from, scenario: chatState.scenario, report }));
        } catch (error) {
            console.error(`❌ [Chat Manager] Report generation failed: ${error.message}`);
        }

        this.activeChats.delete(from);
    }
}

module.exports = new ChatManager();
