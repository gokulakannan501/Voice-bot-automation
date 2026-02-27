const OpenAI = require('openai');

class LLMService {
    constructor() {
        this.openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
        });
    }

    /**
     * Process customer transcription and determine the bot's next response
     * @param {string} transcript - What the customer said
     * @param {object} callState - The current state of the call (e.g. conversational history)
     * @returns {Promise<{replyText: string, updatedState: object}>}
     */
    async processCustomerIntent(transcript, callState) {
        // Define the scenario-specific instructions
        let scenarioInstructions = '';
        if (callState.scenario === 'BOOKING') {
            scenarioInstructions = `TEST SCENARIO: Book Appointment
Your ONLY goal for this call is to book an appointment with a Doctor. Provide your details when asked. Your specific medical reason for visiting is: "${callState.symptom}". You must strictly only use this symptom during the entire call. Confirm the appointment details. End with "Thank you". Do NOT cancel anything.`;
        } else if (callState.scenario === 'CANCELLATION') {
            scenarioInstructions = `TEST SCENARIO: Cancel Appointment
Your ONLY goal for this call is to cancel an appointment you booked earlier. Say you want to cancel. Provide your phone number and name when asked. If the bot asks which appointment to cancel, pick any of them. Confirm the cancellation. End with "Thank you". Do NOT book anything new.`;
        }

        const todayDate = new Date();
        const tomorrowDate = new Date(todayDate);
        tomorrowDate.setDate(tomorrowDate.getDate() + 1);
        const nextWeekDate = new Date(todayDate);
        nextWeekDate.setDate(nextWeekDate.getDate() + 7);

        const formatDate = (date) => date.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

        // System Prompt defining the AI as the Human User/Tester
        let systemPrompt = `You are an automated voice-call tester acting as a real patient calling a hospital.
        
CRITICAL TEST TARGET INSTRUCTIONS:
1. At the VERY BEGINNING of this call, you must INVENT a specific date and time for your appointment.
2. The date MUST be between ${formatDate(todayDate)} and ${formatDate(new Date(todayDate.getTime() + 15 * 24 * 60 * 60 * 1000))}.
3. The time MUST be a specific slot like "10:30 AM", "4 PM", or "8 PM". 
4. VARIETY IS MANDATORY: You must pick a DIFFERENT day and time for every single call. Do NOT repeat yourself.
5. Once you choose your target date/time, LOCK IT IN YOUR BRAIN. You must spend the rest of the call trying to book EXACTLY that slot.
6. YOUR SYMPTOM: ${callState.symptom}. You must stick to this.`;

        // Inject OTP logic if provided in state
        if (callState.latestReceivedOTP) {
            systemPrompt += `\nCRITICAL INFO: You just received a text message with the OTP code ${callState.latestReceivedOTP}. If the bot asks you for an OTP, read this code to them slowly and clearly in digit format (e.g. 'one two three four').\n`;
        }

        systemPrompt += `
GOAL:
Test the hospital appointment voice bot by having natural conversations like a human caller.

BEHAVIOR RULES:
1. Speak naturally like a normal person. Keep your responses to one or two short sentences. Do not provide all information at once.
2. Do not mention that you are an AI or tester.
3. Ask questions clearly and politely.
4. Provide realistic patient details when asked.
5. NEGOTIATION & VERIFICATION: 
   - You MUST ask for the specific date and time you invented at the start.
   - If the bot offers a DIFFERENT time or date (e.g. if you asked for 8 PM but the bot offers 18:00/6 PM), you MUST refuse and say: "No, that's not what I asked for. I need 8 PM specifically."
   - YOU MUST RECOGNIZE MILITARY TIME: "eighteen hundred" or "18:00" is 6 PM. If it doesn't match your target, CORRECT THE BOT.
   - Do NOT say "Yes" or "Confirm" unless the bot accurately repeats YOUR requested slot.
6. If the bot fails to correct itself twice or continues providing wrong details, end the call with a feedback message.
7. CRITICAL: YOU ARE THE PATIENT CALLING THE HOSPITAL. You are NOT the receptionist. DO NOT offer to help the bot. YOU are the one who needs help.
8. When asked for the type of visit or appointment, if you choose the in-person option, you MUST say exactly "In Person". Do NOT say "In person, please". Keep it simple and direct.

PATIENT PROFILE:
Name: Gokulakannan
Age: 30
Gender: Male
Phone: 6374038470

${scenarioInstructions}

VOICE STYLE:
Friendly, calm, normal pace.

CONFUSION TESTING RULES (Use these OCCASIONALLY to test bot robustness):
1. Redundant Times: Use redundant time formats like "5 o'clock 5 PM" if that matches your target time.
2. Changing Mind: Sometimes change your mind mid-sentence, e.g., "I'd like 4 PM... wait, actually make it [your target time]."

ERROR HANDLING:
If bot response is unclear: Say "Sorry, can you repeat?"
If bot not responding: Say "Hello, are you there?"
If the bot's sentence ends abruptly and is clearly cut off mid-thought at the VERY END (e.g., ends with "Your appointment is", "The doctor will"), you MUST reply with exactly the word "WAIT".
CRITICAL: Do NOT say "WAIT" if the transcript ends with a complete name, a fully spoken option in a list (e.g., "...four, Manikarnika."), or any completed thought, even if there are grammatical errors earlier in the sentence. Instead, you MUST pick one of the options.
When responding to a numbered list of options, DO NOT say the number (like "number one" or "number two"). ONLY say the exact text of the option you are picking.

CRITICAL DATE RULE: You must ABSOLUTELY use the correct year (which is ${todayDate.getFullYear()}).
- VARIETY: Pick a UNIQUE target date and time for this call. USE IT.

END CONDITION:
After completing scenario, politely end call.
CRITICAL: If the target bot repeats the exact same question or gets stuck in a loop for 4 attempts without moving forward, you MUST reply with exactly the word "END_CALL_LOOP". Do not say anything else.

CRITICAL LANGUAGE TEST RULE:
1. You MUST conduct the ENTIRE call in ${callState.targetLanguage}.
2. Even if the hospital bot greets you in English, your VERY FIRST reply MUST be spoken natively in ${callState.targetLanguage}.
3. Simple reason for calling (e.g., "I want to book an appointment") directly in ${callState.targetLanguage}.
4. IGNORE any audio transcripts that sound like podcast hosts (e.g. "Satya", "solar system", "Colab Tech"). These are transcription errors.`;

        // console.log(`[LLM] Processing transcript: "${transcript}"`);

        try {
            const response = await this.openai.chat.completions.create({
                model: "gpt-4o",
                messages: [
                    { role: "system", content: systemPrompt },
                    ...callState.history,
                    { role: "user", content: transcript }
                ]
            });

            const replyText = response.choices[0].message.content;

            return {
                replyText: replyText,
                updatedState: { ...callState, lastIntentProcessed: true }
            };
        } catch (error) {
            console.error("[LLM] OpenAI API Error:", error.message);
            return {
                replyText: "I'm sorry, I am having trouble connecting to my brain right now.",
                updatedState: callState
            };
        }
    }

    /**
     * Fast pre-processing check to determine if the transcribed audio is actually a known 
     * OpenAI Whisper hallucination (e.g. YouTube intros, podcast hosts, etc.)
     * @param {string} transcript 
     * @param {string} targetLanguage - The language the tester is supposed to be speaking
     * @param {string} detectedLanguageCode - The language the STT engine thinks it heard
     * @returns {Promise<boolean>}
     */
    async isHallucination(transcript, targetLanguage = "English", detectedLanguageCode = "en-IN") {
        if (!transcript || transcript.trim().length < 2) return true;

        const systemPrompt = `You are a strict QA voice data filter. Your job is to determine if a transcript from a hospital appointment call is a "Whisper AI Hallucination" (phantom text) or real speech.

CONTEXT:
- The user is testing a bot in: ${targetLanguage}
- The STT engine detected the audio as: ${detectedLanguageCode}

STRICT FILTERING RULES:
1. CROSS-LANGUAGE LEAKAGE: If the detected language (${detectedLanguageCode}) is DIFFERENT from the target test language (${targetLanguage}), you should be highly suspicious.
   - Example: If target is English but you see Odia/Bengali characters like "ହଁ", it is 100% a hallucination. Mark as true.
2. REPETITION: If the same word/syllable is repeated (e.g. "mm-hmm mm-hmm", "Yes yes yes yes"), mark as true.
3. COMMON WHISPER PHANTOMS:
   - "Welcome to my channel", "Subscribe", "Hit the bell"
   - "This is your host Satya"
   - "Solar System"
   - "Subtitle credits", "Transcribed by..."
4. SHORT NONSENSE: Single words in the WRONG language that sound like line pops (e.g. Odia "Yes") must be blocked.

You must output a JSON object: {"isHallucinated": boolean}
Return true if it is a hallucination or the wrong language.
Return false ONLY if it is a meaningful sentence in ${targetLanguage} related to a hospital appointment.`;

        try {
            const response = await this.openai.chat.completions.create({
                model: "gpt-4o-mini",
                response_format: { type: "json_object" },
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: `Detected Text: "${transcript}"` }
                ],
                temperature: 0.1
            });

            const result = JSON.parse(response.choices[0].message.content);
            return result.isHallucinated === true;
        } catch (error) {
            console.error("[LLM Filter] Error checking hallucination:", error.message);
            return false;
        }
    }

    /**
     * Analyzes the entire call history to generate a structured test report
     * @param {object} callState - The full call state context
     * @returns {Promise<object>} - JSON object containing the report
     */
    async generateTestReport(callState) {
        const chatHistory = callState.history;
        const scenario = callState.scenario;

        if (!chatHistory || chatHistory.length === 0) {
            return {
                status: "Skipped",
                uxAnalysis: "Call ended before any conversation occurred.",
                enhancements: ["Ensure target bot answers and speaks promptly."]
            };
        }

        const systemPrompt = `You are a strict QA Test Engineer evaluating a conversation between an AI Patient (User) and a Hospital Voice Bot (Assistant).
        
The AI Patient was explicitly instructed to perform the following scenario: ${callState.targetLanguage} ${scenario}

Analyze the conversation transcript provided to you.
Your goal is to determine if the Hospital Voice Bot successfully handled the user's intent to ${scenario === 'BOOKING' ? 'book an appointment' : 'cancel an appointment'} AND successfully detected and spoke ${callState.targetLanguage}.

Extract and output the following JSON structure exactly:
{
    "status": "Passed" | "Failed",
    "isBookingConfirmed": true | false,
    "languageDetectionSuccess": true | false,
    "uxAnalysis": "A 1-2 sentence description of the user experience. Did the bot successfully detect that the user was speaking ${callState.targetLanguage} and switch over? Was the flow natural?",
    "enhancements": [
        "Be highly specific and actionable. Format as 'Where: [Context]. What: [Detailed fix]'. Example: 'Where: When presenting slots - What: Explicitly read out available times one-by-one and ask for a selection.'",
        "Another specific enhancement here"
    ]
}

- Mark "Passed" if the bot successfully answered questions or booked/cancelled the appointment gracefully AND successfully switched to ${callState.targetLanguage}.
- Mark "isBookingConfirmed" as true ONLY if you are absolutely certain the hospital bot successfully secured and confirmed an appointment slot (even if the overall UX was poor and status is Failed).
- Mark "languageDetectionSuccess" as true if the Assistant responded in ${callState.targetLanguage} naturally.
- Mark "Failed" if the bot crashed, got stuck in a loop, gave incorrect info, abruptly hung up, OR failed to switch to the correct language.`;

        try {
            const transcriptText = chatHistory.map(msg => `${msg.role === 'user' ? 'Target Bot' : 'AI Tester'}: ${msg.content}`).join('\\n');

            const response = await this.openai.chat.completions.create({
                model: "gpt-4o",
                response_format: { type: "json_object" },
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: `Here is the transcript of the call:\n\n${transcriptText}` }
                ],
                temperature: 0.2
            });

            return JSON.parse(response.choices[0].message.content);
        } catch (error) {
            console.error("[LLM Report Error]:", error.message);
            return {
                status: "Failed",
                uxAnalysis: "Failed to generate evaluation report due to API error.",
                enhancements: []
            };
        }
    }
}

module.exports = new LLMService();
