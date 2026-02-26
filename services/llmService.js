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

GOAL:
Test the hospital appointment voice bot by having natural conversations like a human caller.

BEHAVIOR RULES:
1. Speak naturally like a normal person. Keep your responses to one or two short sentences. Do not provide all information at once.
2. Do not mention that you are an AI or tester.
3. Ask questions clearly and politely.
4. Provide realistic patient details when asked.
5. If bot gives wrong answer, ask again politely.
6. If bot fails twice, end call with feedback message.
7. CRITICAL: YOU ARE THE PATIENT CALLING THE HOSPITAL. You are NOT the receptionist. DO NOT offer to help the bot. YOU are the one who needs help.

PATIENT PROFILE:
Name: Gokulakannan
Age: 30
Gender: Male
Phone: 6374038470

${scenarioInstructions}

VOICE STYLE:
Friendly, calm, normal pace.

ERROR HANDLING:
If bot response is unclear: Say "Sorry, can you repeat?"
If bot not responding: Say "Hello, are you there?"
If the bot's sentence ends abruptly and is clearly cut off mid-thought at the VERY END (e.g., ends with "Your appointment is", "The doctor will"), you MUST reply with exactly the word "WAIT".
CRITICAL: Do NOT say "WAIT" if the transcript ends with a complete name, a fully spoken option in a list (e.g., "...four, Manikarnika."), or any completed thought, even if there are grammatical errors earlier in the sentence. Instead, you MUST pick one of the options.
When responding to a numbered list of options, DO NOT say the number (like "number one" or "number two"). ONLY say the exact text of the option you are picking.
If the bot asks for a date or time, YOU MUST pick a specific answer within ONE MONTH from today. The exact dates you can choose from are:
- TODAY is: ${formatDate(todayDate)}
- TOMORROW is: ${formatDate(tomorrowDate)}
- NEXT WEEK is: ${formatDate(nextWeekDate)}

CRITICAL DATE RULE: You must ABSOLUTELY use the correct year (which is ${todayDate.getFullYear()}) when determining the day of the week. Do not hallucinate past years.
- Use natural phrases referring to the exact dates above like: "Tomorrow morning", "Tomorrow", "Today evening", "Next week ${nextWeekDate.toLocaleDateString('en-US', { weekday: 'long' })}".
- Use times like: "10 AM", "12 PM", "6 PM".
- CRITICAL TEST: OCCASIONALLY, intentionally give a PAST date (e.g. "yesterday" or a date from last week) to test if the target bot correctly detects the error and rejects it.

END CONDITION:
After completing scenario, politely end call.
CRITICAL: If the target bot repeats the exact same question or gets stuck in a loop for 4 attempts without moving forward, you MUST reply with exactly the word "END_CALL_LOOP". Do not say anything else.

CRITICAL INSTRUCTION: You MUST speak in the EXACT regional language that the clinic's bot speaks to you. 
- IF THE BOT SPEAKS ENGLISH, YOU MUST REPLY IN 100% ENGLISH. DO NOT SPEAK TAMIL, HINDI, OR TELUGU UNLESS THE BOT DOES FIRST.
- IF the bot speaks a regional language (e.g., Hindi, Tamil), naturally mix in common English words (using "Hinglish"/"Tanglish"). For example, use English for medical terms like "appointment", "doctor", "fever".
- ALWAYS speak phone numbers and digits in English (e.g., say "nine eight seven").
- IGNORE any audio transcripts that sound like podcast hosts (e.g. "Satya", "solar system", "Colab Tech"). These are transcription errors.`;

        // Inject the latest OTP if we have received one via SMS
        const callManager = require('../engine/callManager');
        if (callManager.latestReceivedOTP) {
            systemPrompt += `\nCRITICAL INFO: You just received a text message with the OTP code ${callManager.latestReceivedOTP}. If the bot asks you for an OTP, read this code to them slowly and clearly in digit format (e.g. 'one two three four').`;
        }

        console.log(`[LLM] Processing transcript: "${transcript}"`);

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
     * @returns {Promise<boolean>}
     */
    async isHallucination(transcript) {
        if (!transcript || transcript.trim().length < 2) return true;

        const systemPrompt = `You are a strict data filter. Your job is to read an audio transcript from a phone call and determine if it is a "Whisper AI Hallucination".

Sometimes when Speech-to-Text models hear pure silence or static, they hallucinate phantom text from their training data (mostly YouTube videos and Podcasts).
Common hallucinated phrases include:
- "Welcome to my channel"
- "Subscribe to my channel"
- "Hit the bell icon"
- "This is your host Satya"
- "Solar System"
- "Tech tips and tricks"
- Subtitle credits like "Subtitles by Amara"

You must output a JSON object: {"isHallucinated": boolean}
Return true ONLY if it sounds like a YouTube/Podcast hallucination, a subtitle credit, or complete gibberish (like "mm-hmm" repeated 10 times).
Return false if it sounds like a normal human or clinic bot speaking (even if it's just "Hello" or "Yes").`;

        try {
            const response = await this.openai.chat.completions.create({
                model: "gpt-4o-mini", // Use mini for maximum speed
                response_format: { type: "json_object" },
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: transcript }
                ],
                temperature: 0.1
            });

            const result = JSON.parse(response.choices[0].message.content);
            return result.isHallucinated === true;
        } catch (error) {
            console.error("[LLM Filter] Error checking hallucination:", error.message);
            // Default to false so we don't accidentally drop valid transcripts if the API fails
            return false;
        }
    }

    /**
     * Analyzes the entire call history to generate a structured test report
     * @param {Array} chatHistory - The history array from the CallState
     * @param {string} scenario - The scenario that was executed (BOOKING or CANCELLATION)
     * @returns {Promise<object>} - JSON object containing the report
     */
    async generateTestReport(chatHistory, scenario) {
        if (!chatHistory || chatHistory.length === 0) {
            return {
                status: "Skipped",
                uxAnalysis: "Call ended before any conversation occurred.",
                enhancements: ["Ensure target bot answers and speaks promptly."]
            };
        }

        const systemPrompt = `You are a strict QA Test Engineer evaluating a conversation between an AI Patient (User) and a Hospital Voice Bot (Assistant).
        
The AI Patient was explicitly instructed to perform the following scenario: ${scenario}

Analyze the conversation transcript provided to you.
Your goal is to determine if the Hospital Voice Bot successfully handled the user's intent to ${scenario === 'BOOKING' ? 'book an appointment' : 'cancel an appointment'}.

Extract and output the following JSON structure exactly:
{
    "status": "Passed" | "Failed",
    "isBookingConfirmed": true | false,
    "uxAnalysis": "A 1-2 sentence description of the user experience. Did the bot understand the user? Was it confused? Was the flow natural?",
    "enhancements": [
        "Be highly specific and actionable. Format as 'Where: [Context]. What: [Detailed fix]'. Example: 'Where: When presenting slots - What: Explicitly read out available times one-by-one and ask for a selection.'",
        "Another specific enhancement here"
    ]
}

- Mark "Passed" if the bot successfully answered questions or booked/cancelled the appointment gracefully.
- Mark "isBookingConfirmed" as true ONLY if you are absolutely certain the hospital bot successfully secured and confirmed an appointment slot (even if the overall UX was poor and status is Failed).
- Mark "Failed" if the bot crashed, got stuck in a loop, gave incorrect info, or abruptly hung up without resolving the intent.`;

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
