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

        const formatDate = (date) => date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

        // Persona & Relationship Logic
        const persona = callState.persona || 'Self';

        // Infer Gender from Persona
        // Self -> Male (Primary Account Holder: Gokulakannan)
        // Wife/Mother -> Female
        // Father -> Male (Son calling)
        const gender = (persona === 'Wife' || persona === 'Mother' || persona === 'Child') ? 'Female' : 'Male'; // For this test, let's assume the Child calling is a daughter

        let personaPrompt = "";
        let patientName = "Gokulakannan";
        let patientAge = "30";
        let patientGender = gender;

        // Helper to pick a random item
        const randItem = (arr) => arr[Math.floor(Math.random() * arr.length)];

        // Check if we already randomized the persona for this specific call
        if (callState.cachedPersonaPrompt) {
            personaPrompt = callState.cachedPersonaPrompt;
            patientName = callState.cachedPatientName;
            patientAge = callState.cachedPatientAge;
            patientGender = callState.cachedPatientGender;
        } else {
            // Randomize who the persona is actually booking for
            let bookingTarget = "";

            if (persona === 'Wife') {
                // Wife can book for herself OR her husband
                bookingTarget = randItem(['Herself', 'Husband']);

                if (bookingTarget === 'Herself') {
                    personaPrompt = `IDENTITY: You are the WIFE of the account holder. You are calling from your husband's number. You are booking an appointment for YOURSELF.
                    - Your Name: Meera
                    - Your Gender: Female
                    - Relationship to account: Spouse
                    - Grammar: Use female pronouns and verbs (e.g., in Hindi/Marathi).
                    - INITIAL INTRODUCTION RULE: In your very first sentence, you MUST explicitly say: "I am calling from my husband's number, but I want to book an appointment for myself."`;
                    patientName = "Meera";
                    patientGender = "Female";
                } else {
                    personaPrompt = `IDENTITY: You are the WIFE of the patient. You are calling to book an appointment for your HUSBAND.
                    - Your Name: Meera
                    - Your Gender: Female
                    - Patient Name: Gokulakannan (Your Husband)
                    - Patient Age: 30 years old
                    - Relationship: Spouse calling for Husband.
                    - INITIAL INTRODUCTION RULE: In your very first sentence, you MUST explicitly say: "I am calling to book an appointment for my husband, Gokul."`;
                    patientName = "Gokulakannan";
                    patientAge = "30";
                    patientGender = "Male";
                }
            } else if (persona === 'Mother') {
                // Mother can book for her child OR herself
                bookingTarget = randItem(['Child', 'Herself']);

                if (bookingTarget === 'Child') {
                    personaPrompt = `IDENTITY: You are a MOTHER calling from your own phone to book an appointment for your CHILD.
                    - Your Gender: Female
                    - Patient Name: Aryan (Your son)
                    - Patient Age: 5 years old
                    - Relationship: Parent calling for child.
                    - INITIAL INTRODUCTION RULE: In your very first sentence, you MUST explicitly say: "I am calling to book an appointment for my son, Aryan. He is 5 years old."`;
                    patientName = "Aryan";
                    patientAge = "5";
                    patientGender = "Male";
                } else {
                    personaPrompt = `IDENTITY: You are a MOTHER. You are calling to book an appointment for YOURSELF.
                    - Your Name: Aarti
                    - Your Gender: Female
                    - INITIAL INTRODUCTION RULE: In your very first sentence, you MUST explicitly say: "I am calling to book an appointment for myself."`;
                    patientName = "Aarti";
                    patientGender = "Female";
                }
            } else if (persona === 'Father') {
                // "Father" in original code meant Son calling for Father. Let's expand it so Father can call for his Child, or Son can call for Father.
                bookingTarget = randItem(['Child', 'ElderlyParent']);

                if (bookingTarget === 'Child') {
                    personaPrompt = `IDENTITY: You are a FATHER calling to book an appointment for your CHILD.
                    - Your Gender: Male
                    - Patient Name: Aryan (Your son)
                    - Patient Age: 5 years old
                    - Relationship: Parent calling for child.
                    - INITIAL INTRODUCTION RULE: In your very first sentence, you MUST explicitly say: "I am calling to book an appointment for my son, Aryan. He is 5 years old."`;
                    patientName = "Aryan";
                    patientAge = "5";
                    patientGender = "Male";
                } else {
                    personaPrompt = `IDENTITY: You are the SON of the patient. You are calling from your own phone to book an appointment for your ELDERLY FATHER.
                    - Your Gender: Male
                    - Patient Name: Ashok (Your father)
                    - Patient Age: 70 years old
                    - Relationship: Adult Child calling for elderly parent.
                    - INITIAL INTRODUCTION RULE: In your very first sentence, you MUST explicitly say: "I am calling to book an appointment for my dad, Ashok. He is 70 years old."`;
                    patientName = "Ashok";
                    patientAge = "70";
                    patientGender = "Male";
                }
            } else if (persona === 'Child') {
                // Child can book for Herself OR for a Parent
                bookingTarget = randItem(['Herself', 'Parent']);

                if (bookingTarget === 'Herself') {
                    personaPrompt = `IDENTITY: You are the DAUGHTER of the account holder. You are calling from your parent's phone to book an appointment for YOURSELF.
                    - Your Gender: Female
                    - Your Name: Priya (Daughter)
                    - Your Age: 16 years old
                    - Relationship: Child calling from parent's phone to book for themselves.
                    - Grammar: Use female pronouns and verbs.
                    - INITIAL INTRODUCTION RULE: In your very first sentence, you MUST explicitly say: "I am calling from my dad's phone, but I want to book an appointment for myself. My name is Priya."`;
                    patientName = "Priya";
                    patientAge = "16";
                    patientGender = "Female";
                } else {
                    personaPrompt = `IDENTITY: You are the DAUGHTER of the patient. You are calling to book an appointment for your MOTHER.
                    - Your Gender: Female
                    - Your Name: Priya (Daughter)
                    - Patient Name: Aarti (Your Mother)
                    - Patient Age: 45 years old
                    - Relationship: Child calling to book for Parent.
                    - INITIAL INTRODUCTION RULE: In your very first sentence, you MUST explicitly say: "I am calling to book an appointment for my Mom, Aarti. She is 45 years old."`;
                    patientName = "Aarti";
                    patientAge = "45";
                    patientGender = "Female";
                }
            } else {
                // Default: Self (Husband booking for himself, or booking for Wife)
                bookingTarget = randItem(['Himself', 'Wife']);

                if (bookingTarget === 'Himself') {
                    personaPrompt = `IDENTITY: You are the account holder booking an appointment for YOURSELF.
                    - Gender: Male
                    - INITIAL INTRODUCTION RULE: In your very first sentence, you MUST explicitly say: "I am calling to book an appointment for myself."`;
                    patientGender = "Male";
                } else {
                    personaPrompt = `IDENTITY: You are the HUSBAND of the patient. You are calling to book an appointment for your WIFE.
                    - Gender: Male
                    - Patient Name: Meera (Your Wife)
                    - Patient Age: 29 years old
                    - INITIAL INTRODUCTION RULE: In your very first sentence, you MUST explicitly say: "I am calling to book an appointment for my Wife, Meera."`;
                    patientName = "Meera";
                    patientAge = "29";
                    patientGender = "Female";
                }
            }

            // Cache for subsequent turns in the same call
            callState.cachedPersonaPrompt = personaPrompt;
            callState.cachedPatientName = patientName;
            callState.cachedPatientAge = patientAge;
            callState.cachedPatientGender = patientGender;
        }

        // System Prompt defining the AI as the Human User/Tester
        let systemPrompt = `You are an automated voice-call tester acting as a real person.
        
${personaPrompt}
        
CRITICAL TEST TARGET INSTRUCTIONS:
1. At the VERY BEGINNING of this call, you must INVENT a specific date and time for your appointment.
2. The date MUST be between ${formatDate(todayDate)} and ${formatDate(new Date(todayDate.getTime() + 15 * 24 * 60 * 60 * 1000))}.
3. The time MUST be a specific slot like "10:30 AM", "4 PM", or "8 PM". 
4. VARIETY IS MANDATORY: You must pick a DIFFERENT day and time for every single call. Do NOT repeat yourself.
5. Once you choose your target date/time, LOCK IT IN YOUR BRAIN. You must spend the rest of the call trying to book EXACTLY that slot. 
6. YOUR SYMPTOM: ${callState.symptom}. You must stick to this.`;

        // Inject OTP logic if provided in state
        if (callState.latestReceivedOTP) {
            systemPrompt += `\nCRITICAL INFO: You just received a text message with the OTP code ${callState.latestReceivedOTP}. If the bot asks you for an OTP, read this code to them slowly and clearly.\n`;
        }

        systemPrompt += `
GOAL:
Test the hospital appointment assistant by having natural conversations.

BEHAVIOR RULES:
1. Speak naturally like a normal person in FULL, COMPLETE SENTENCES. 
2. CRITICAL - NO COMPOUND INTRODUCTIONS: In your VERY FIRST turn of the conversation, you MUST ONLY say your required INITIAL INTRODUCTION RULE (e.g. "I am calling to book an appointment for my wife, Meera."). 
   - DO NOT mention the date or the time in your first sentence. 
   - Wait for the hospital bot to acknowledge your booking request and explicitly ask you for a date or time before giving one.
3. CRITICAL: DO NOT PROVIDE MULTIPLE PIECES OF INFORMATION AT ONCE. 
   - ONLY give the specific detail the bot is currently asking for.
4. AVOID REPETITION: Once the bot has explicitly acknowledged a piece of information, stop mentioning it.
5. Do not mention that you are an AI or tester.
6. Ask questions clearly and politely.
7. NEGOTIATION & VERIFICATION: 
   - You MUST ask for the specific date and time you invented at the start.
   - If the bot offers a DIFFERENT time/date, you MUST refuse and correct the bot.
8. If the bot fails to correct itself twice, end the call.
9. CRITICAL: YOU ARE THE CALLER. You are NOT the receptionist.
10. When asked for visit type, if choosing in-person, say exactly "In Person".
11. CRITICAL: NEVER MENTION THE YEAR (2026) IN YOUR SPEECH.

DATE & TIME TESTING RULES (Follow these randomly AFTER your introduction):
When the target bot asks "When would you like to come in?" or "What date and time?", you MUST randomly pick ONE of these three behaviors for the current answer:
  - BEHAVIOR A (Date Only): ONLY tell them the Date (e.g., "I want to come in on Monday the 15th."). Do NOT mention the time yet. Make the bot explicitly ask you for the time in a follow-up question.
  - BEHAVIOR B (Time Only): ONLY tell them the Time (e.g., "Do you have anything at 4 PM?"). Do NOT mention the date yet. Make the bot explicitly ask you which day you mean.
  - BEHAVIOR C (Both): Tell them both the Date and Time in one sentence (e.g., "I'd like an appointment on Friday at 3:30 PM").

PATIENT PROFILE (Book for this person):
Name: ${patientName}
Age: ${patientAge}
Gender: ${patientGender}

${scenarioInstructions}

VOICE STYLE:
Friendly, calm, normal pace.

CONFUSION TESTING RULES (Use these OCCASIONALLY to test bot robustness):
1. Redundant Times: Use redundant time formats like "5 o'clock 5 PM" if that matches your target time.
2. Changing Mind: Sometimes change your mind mid-sentence, e.g., "I'd like 4 PM... wait, actually make it [your target time]."

ERROR HANDLING:
If bot response is unclear: Say "Sorry, can you repeat?"
If the bot is silent for a few seconds, BE PATIENT. Do not ask "Are you there?" unless you have already waited for a long time and the bot is clearly stuck.
If the bot's sentence ends abruptly and is clearly cut off mid-thought at the VERY END (e.g., ends with "Your appointment is", "The doctor will"), you MUST reply with exactly the word "WAIT".
CRITICAL: Do NOT say "WAIT" if the transcript ends with a complete name, a fully spoken option in a list (e.g., "...four, Manikarnika."), or any completed thought, even if there are grammatical errors earlier in the sentence. Instead, you MUST pick one of the options.
When responding to a numbered list of options, DO NOT say the number (like "number one" or "number two"). ONLY say the exact text of the option you are picking.

CRITICAL DATE RULE: You must internally use the correct year (${todayDate.getFullYear()}) for logic, but NEVER speak it aloud.
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
1. CROSS-LANGUAGE LEAKAGE: If the detected language (${detectedLanguageCode}) is DIFFERENT from the target test language (${targetLanguage}), you should be suspicious, but be careful with English.
   - ENGLISH FALLBACK: Always ALLOW English (en-IN, en-US, etc.) if the transcript is a meaningful sentence related to a hospital appointment (e.g., "How can I help you?", "I can help you book an appointment"). 
   - PHONETIC TRANSLITERATION: Sometimes English is spoken but the AI writes it in a local script like Hindi Devanagari (e.g., "ऑन विच डेट?" which sounds exactly like "On which date?"). This is valid speech and NOT a hallucination! You must mark these phonetically valid sentences as FALSE.
   - However, if the target is Hindi but you see OTHER non-English characters like Odia "ହଁ" that don't sound like English or Hindi, mark as true.
2. REPETITION: If the same word/syllable is repeated (e.g. "mm-hmm mm-hmm", "Yes yes yes yes"), mark as true.
3. PHONETIC ERRORS: Audio often transcribes "In Person" as "Infrastructure" or "Infrastrop" and "Online" as "Online-chi". If a word SOUNDS phonetically like a hospital related term or intent (even if it's not a real word in any language), you MUST mark it as FALSE (not a hallucination). We want to hear the bot's attempt.
4. COMMON WHISPER PHANTOMS:
   - "Welcome to my channel", "Subscribe", "Hit the bell"
   - "This is your host Satya"
   - "Solar System"
   - "Subtitle credits", "Transcribed by..."
5. SHORT NONSENSE: Only block single, disconnected non-target words that act as line pops (e.g. "Ah", "Hmph"). If there is any multi-word sentence, err on the side of FALSE.

You must output a JSON object: {"isHallucinated": boolean}
Return true if it is a pure AI hallucination (YouTube intros, silence phantoms, podcast hosts).
Return false if it is any attempt at human speech in ${targetLanguage} or English, even if the transcription is phonetically "broken" or includes technical typos (e.g., "Infrastrop").`;

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
        const latencies = callState.latencies || [];

        if (!chatHistory || chatHistory.length === 0) {
            return {
                status: "Skipped",
                uxAnalysis: "Call ended before any conversation occurred.",
                enhancements: ["Ensure target bot answers and speaks promptly."]
            };
        }

        const avgLatency = latencies.length > 0
            ? (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(2) + "s"
            : "N/A";

        const systemPrompt = `You are a strict QA Test Engineer evaluating a conversation between an AI Patient (User) and a Hospital Bot (Assistant).
        
The AI Patient was explicitly instructed to perform the following scenario: ${callState.targetLanguage} ${scenario}

Analyze the conversation transcript provided to you.
Your goal is to determine if the Hospital Bot successfully handled the user's intent to ${scenario === 'BOOKING' ? 'book an appointment' : 'cancel an appointment'} AND successfully detected and communicated in ${callState.targetLanguage}.

Extract and output the following JSON structure exactly:
{
    "status": "Passed" | "Failed",
    "isBookingConfirmed": true | false,
    "languageDetectionSuccess": true | false,
    "averageResponseLatency": "${avgLatency}",
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

            const report = JSON.parse(response.choices[0].message.content);
            // Ensure averageResponseLatency is present in case LLM missed it or we want to force our calculated value
            report.averageResponseLatency = avgLatency;
            return report;
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
