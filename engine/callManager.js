const llmService = require('../services/llmService');
const sarvamService = require('../services/sarvamService');
const { WaveFile } = require('wavefile');

class CallManager {
    constructor() {
        // activeCalls will hold conversational context for each Exotel Call SID
        this.activeCalls = new Map();

        // Track the scenario for the NEXT call (alternates between BOOKING and CANCELLATION)
        this.nextScenario = 'BOOKING';
        this.pendingTestLanguage = 'English';
        this.manualOverrideResponse = null;
        this.latestReceivedOTP = null;         // Stores the last OTP injected via dashboard
    }

    /**
     * Initializes a new call session
     * @param {string} callSid 
     * @param {WebSocket} ws
     */
    startCall(callSid, ws) {
        // Assign the current scenario and language to this call
        const currentScenario = this.nextScenario;
        const currentLanguage = this.pendingTestLanguage || 'English';

        // Reset override for new call start
        this.manualOverrideResponse = null;

        console.log(`[Call Manager] Started tracking new call: ${callSid} | Scenario: ${currentScenario} | Language: ${currentLanguage}`);

        // Assign a diverse random symptom for this phone call
        const symptomOptions = ['fever', 'severe headache', 'stomach ache', 'lower back pain', 'persistent cough', 'sore throat', 'knee pain', 'body fatigue', 'skin rash', 'mild chest pain'];
        const randomSymptom = symptomOptions[Math.floor(Math.random() * symptomOptions.length)];

        // 2-Minute Initial Timeout for unreachable bot (Watchdog)
        this.resetWatchdog(callSid, 120000, "Target bot unreachable (no connection) for 2 minutes.");

        this.activeCalls.set(callSid, {
            history: [],
            isBookingConfirmed: false,
            scenario: currentScenario,
            targetLanguage: currentLanguage,
            symptom: randomSymptom,   // Assigned to this specific call
            startTime: Date.now(),
            audioBuffer: [],          // Holds all audio chunks while the bot is speaking
            silenceTimer: null,       // The stopwatch waiting for silence
            watchdogTimeout: null,    // The per-turn hang detector
            hasSpoken: false,         // Tracks if the user has triggered VAD yet
            isProcessing: false,      // Tracks if the NLP pipeline is currently active
            isEnding: false,           // Prevents endCall from executing twice
            ws: ws,                   // Store reference to close call if needed
            packetCount: 0            // Debug: track packets received
        });
    }

    /**
     * Resets or starts a watchdog timer for a specific call
     */
    resetWatchdog(callSid, ms, reason) {
        const callState = this.activeCalls.get(callSid);
        if (!callState) return;

        if (callState.watchdogTimeout) {
            clearTimeout(callState.watchdogTimeout);
        }

        callState.watchdogTimeout = setTimeout(() => {
            console.log(`🛑 [Watchdog] ${reason} | Call: ${callSid}`);
            callState.history.push({ role: "assistant", content: `[Auto-Terminated: ${reason}]` });

            // Try to find the WS from the caller if needed, but for now we rely on the state-stored WS if we had one
            // However, we can also just call endCall which handles cleanup
            this.endCall(callSid);
        }, ms);
    }

    /**
     * Processes audio chunk from Exotel WEbSocket
     * @param {string} callSid 
     * @param {Buffer} audioChunk 
     * @param {WebSocket} ws 
     */
    async handleIncomingAudio(callSid, audioChunk, ws, rms = 0) {
        try {
            const callState = this.activeCalls.get(callSid);
            if (!callState) return;

            callState.packetCount++;
            if (callState.packetCount === 1) {
                console.log(`[Call Manager] First audio packet received for ${callSid}. RMS: ${rms.toFixed(0)}`);
            }

            // 1. Add newest chunk to the bucket
            callState.audioBuffer.push(audioChunk);

            // Twilio sends 50 chunks a second. If they aren't speaking yet, don't let it grow infinitely.
            if (!callState.hasSpoken && callState.audioBuffer.length > 150) {
                callState.audioBuffer = callState.audioBuffer.slice(-50); // keep a rolling 1-second background noise buffer
            }

            // To prevent Sarvam STT 30-second hard limit crash due to hold music or unbroken noise,
            // cap the speaking buffer to the most recent 28 seconds (1400 chunks * 20ms = 28000ms)
            if (callState.hasSpoken && callState.audioBuffer.length > 1400) {
                // Forcefully trigger transcription by clearing buffer older than 1400, but
                // an even safer bet is to drop the oldest noise to preserve the limit.
                callState.audioBuffer = callState.audioBuffer.slice(-1400);
            }

            const LOUDNESS_THRESHOLD = 300; // Increased from 200 to reduce sensitivity to line pops

            // 2. Clear out any previous stopwatch because the bot just spoke!
            if (rms > LOUDNESS_THRESHOLD) {
                if (callState.silenceTimer) {
                    clearTimeout(callState.silenceTimer);
                    callState.silenceTimer = null;
                }

                // Clear the watchdog as soon as we hear anything from the bot
                if (callState.watchdogTimeout) {
                    clearTimeout(callState.watchdogTimeout);
                    callState.watchdogTimeout = null;
                }

                callState.hasSpoken = true;
            }

            // 3. Start a new stopwatch for 1.5 seconds only if they FINISHED speaking.
            if (rms <= LOUDNESS_THRESHOLD && callState.hasSpoken && !callState.silenceTimer) {
                callState.silenceTimer = setTimeout(async () => {
                    callState.isProcessing = true;
                    try {
                        // Combine all the little chunks into one big audio file (raw PCM)
                        const fullPcmBuffer = Buffer.concat(callState.audioBuffer);
                        // console.log(`\n⏳ [Silence Detected] Hospital bot finished speaking. Processing buffered audio (${fullPcmBuffer.length} bytes)...`);

                        // Empty the bucket for the next sentence
                        callState.audioBuffer = [];
                        callState.hasSpoken = false; // reset VAD state

                        // 4. Create a valid WAV file structure so Sarvam knows the sample rate
                        const uploadWav = new WaveFile();

                        // Convert the raw Node Buffer back into an Int16Array for wavefile
                        const int16Samples = new Int16Array(
                            fullPcmBuffer.buffer,
                            fullPcmBuffer.byteOffset,
                            fullPcmBuffer.length / 2
                        );

                        // Twilio audio was transcoded to 16-bit 8000Hz PCM in server.js before getting here
                        uploadWav.fromScratch(1, 8000, '16', int16Samples);
                        const validWavBuffer = uploadWav.toBuffer();

                        // 5. Send the compliant WAV file to Sarvam STT
                        const { text: transcript, languageCode } = await sarvamService.streamToText(validWavBuffer);

                        if (!transcript || transcript.trim().length < 2) return;

                        // Prevent Sarvam STT Whisper Hallucinations from hitting the bot engine
                        const isFakeAudio = await llmService.isHallucination(transcript, callState.targetLanguage, languageCode);

                        if (isFakeAudio) {
                            console.log(`⚠️ [Audio Filter]: LLM blocked dynamic STT hallucination: "${transcript}" (Detected: ${languageCode}, Target: ${callState.targetLanguage})`);
                            return;
                        }

                        console.log(`🤖 [Target Bot]: "${transcript}"`);
                        callState.history.push({ role: "user", content: transcript });

                        let replyText, updatedState;

                        // 5. Handle Manual Input Override BEFORE calling LLM
                        if (this.manualOverrideResponse) {
                            replyText = this.manualOverrideResponse;
                            console.log(`🎛️ [Manual Override]: Intercepted turn. Using forced response: "${replyText}"`);

                            // Clear the override immediately
                            this.manualOverrideResponse = null;
                            updatedState = { ...callState, lastIntentProcessed: true };
                        } else {
                            // Ask OpenAI what to say back (Pass the OTP if we have one)
                            const result = await llmService.processCustomerIntent(transcript, {
                                ...callState,
                                latestReceivedOTP: this.latestReceivedOTP
                            });
                            replyText = result.replyText;
                            updatedState = result.updatedState;
                        }

                        if (replyText.trim() === "WAIT") {
                            console.log(`⏳ [AI Tester] Detected incomplete sentence. Waiting for the target bot to finish...`);
                            this.activeCalls.set(callSid, updatedState);
                            return; // Do not speak, just keep listening
                        }

                        if (replyText.trim() === "END_CALL_LOOP") {
                            console.log(`🛑 [AI Tester] Detected target bot is stuck in a loop. Auto-terminating call...`);
                            updatedState.history.push({ role: "assistant", content: "[Auto-Terminated by Tester: Target bot is stuck in an infinite loop]" });
                            this.activeCalls.set(callSid, updatedState);

                            // Close the WebSocket connection to physically drop the Twilio call
                            if (ws.readyState === 1) ws.close();
                            return;
                        }

                        this.activeCalls.set(callSid, updatedState);
                        await this.playAIResponse(callSid, replyText, ws, languageCode);
                    } catch (timerError) {
                        console.error(`[Call Manager] Error during transcription/TTS flow: ${timerError.message}`);
                    } finally {
                        callState.isProcessing = false;
                        callState.silenceTimer = null;
                    }
                }, 1200); // Reduced from 2000ms to 1200ms to prevent target bot ASR timeouts
            }

        } catch (error) {
            console.error(`[Call Manager] Error handling audio for ${callSid}: ${error.message}`);
        }
    }

    async endCall(callSid) {
        const callState = this.activeCalls.get(callSid);
        if (callState) {
            // Prevent double execution from both 'stop' and 'close' WebSocket events
            if (callState.isEnding) return;
            callState.isEnding = true;

            // Clear any pending timeouts
            if (callState.watchdogTimeout) {
                clearTimeout(callState.watchdogTimeout);
                callState.watchdogTimeout = null;
            }

            // Wait gracefully for any active STT/LLM generation or pending silence timers to finish 
            // before we package up the history for the report card! (Max 6 seconds timeout)
            let waitLoops = 0;
            while ((callState.isProcessing || callState.silenceTimer) && waitLoops < 60) {
                await new Promise(r => setTimeout(r, 100));
                waitLoops++;
            }

            console.log(`[Call Manager] Call ended: ${callSid}`);

            // Force close the WebSocket if it's still open
            if (callState.ws && callState.ws.readyState === 1) {
                callState.ws.close();
            }

            // Generate Test Report
            if (callState.history && callState.history.length > 0) {
                console.log(`\n📊 [Call Manager] Analyzing call history for Test Report (Language: ${callState.targetLanguage}, Scenario: ${callState.scenario})...`);
                try {
                    const report = await llmService.generateTestReport(callState);
                    console.log(`###REPORT###` + JSON.stringify({ callSid, scenario: callState.scenario, report }));

                    // Determine the scenario for the *next* call based on this call's success
                    if (callState.scenario === 'BOOKING' && report.isBookingConfirmed === true) {
                        this.nextScenario = 'CANCELLATION';
                        console.log(`[Call Manager] Booking was confirmed (even if test failed)! Next incoming call will trigger a CANCELLATION scenario.`);
                    } else {
                        // If booking wasn't confirmed, or we just finished a cancellation cycle, reset back to booking.
                        this.nextScenario = 'BOOKING';
                        console.log(`[Call Manager] Next incoming call will trigger a BOOKING scenario.`);
                    }

                } catch (e) {
                    console.error("[Call Manager] Failed to generate post-call report:", e.message);
                }
            } else {
                console.log(`###REPORT###` + JSON.stringify({
                    callSid,
                    report: {
                        status: "Skipped",
                        uxAnalysis: "Call ended before any conversation occurred.",
                        enhancements: []
                    }
                }));
            }

            this.activeCalls.delete(callSid);
        }
    }

    /**
     * Triggers an AI response without waiting for bot audio (e.g. for initial greeting)
     */
    async triggerAIResponse(callSid, initialText, ws) {
        const callState = this.activeCalls.get(callSid);
        if (!callState || callState.isEnding) return;

        console.log(`[Call Manager] Triggering AI initiative: "${initialText}"`);
        callState.history.push({ role: "assistant", content: `(System: Bot was silent. AI is taking initiative: ${initialText})` });

        const result = await llmService.processCustomerIntent(initialText, {
            ...callState,
            latestReceivedOTP: this.latestReceivedOTP
        });

        const langCode = callState.targetLanguage === 'English' ? 'en-IN' : 'hi-IN';
        await this.playAIResponse(callSid, result.replyText, ws, langCode);
    }

    /**
     * Converts text to speech and streams it to Twilio with jitter-resistant pacing
     */
    async playAIResponse(callSid, replyText, ws, languageCode) {
        const callState = this.activeCalls.get(callSid);
        if (!callState || callState.isEnding) return;

        console.log(`🧑 [AI Tester]: "${replyText}"`);
        callState.history.push({ role: "assistant", content: replyText });
        callState.hasSpoken = true;

        const replyAudioBuffer = await sarvamService.textToStream(replyText, languageCode);
        const wav = new WaveFile();
        wav.fromBuffer(replyAudioBuffer);
        wav.toSampleRate(8000);

        // --- VOLUME BOOST ---
        const VOLUME_MULTIPLIER = 2.5;
        const samples = new Int16Array(wav.data.samples.buffer, wav.data.samples.byteOffset, wav.data.samples.byteLength / 2);
        for (let i = 0; i < samples.length; i++) {
            let boosted = samples[i] * VOLUME_MULTIPLIER;
            if (boosted > 32767) boosted = 32767;
            if (boosted < -32768) boosted = -32768;
            samples[i] = boosted;
        }

        wav.toMuLaw();
        const mulawArray = new Uint8Array(wav.data.samples);
        const CHUNK_SIZE_BYTES = 320;
        let offset = 0;

        if (ws.readyState === 1) {
            while (offset < mulawArray.length) {
                if (ws.readyState !== 1) break;
                const chunkBytes = mulawArray.slice(offset, offset + CHUNK_SIZE_BYTES);
                ws.send(JSON.stringify({
                    event: "media",
                    streamSid: ws.streamSid,
                    media: { payload: Buffer.from(chunkBytes).toString('base64') }
                }));

                const index = offset / CHUNK_SIZE_BYTES;
                offset += CHUNK_SIZE_BYTES;
                if (index >= 5) await new Promise(r => setTimeout(r, 35));
            }
            console.log(`[Call Manager] Successfully finished streaming audio to Twilio.\n`);
            this.resetWatchdog(callSid, 45000, "Target bot hung (no response) for 45 seconds after AI spoke.");
        }
    }
}

module.exports = new CallManager();
