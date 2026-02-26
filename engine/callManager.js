const llmService = require('../services/llmService');
const sarvamService = require('../services/sarvamService');
const { WaveFile } = require('wavefile');

class CallManager {
    constructor() {
        // activeCalls will hold conversational context for each Exotel Call SID
        this.activeCalls = new Map();

        // Track the scenario for the NEXT call (alternates between BOOKING and CANCELLATION)
        this.nextScenario = 'BOOKING';
    }

    /**
     * Initializes a new call session
     * @param {string} callSid 
     */
    startCall(callSid) {
        console.log(`[Call Manager] Started tracking new call: ${callSid} | Scenario: ${this.nextScenario}`);

        // Assign the current scenario to this call
        const currentScenario = this.nextScenario;

        // Assign a diverse random symptom for this phone call
        const symptomOptions = ['fever', 'severe headache', 'stomach ache', 'lower back pain', 'persistent cough', 'sore throat', 'knee pain', 'body fatigue', 'skin rash', 'mild chest pain'];
        const randomSymptom = symptomOptions[Math.floor(Math.random() * symptomOptions.length)];

        this.activeCalls.set(callSid, {
            history: [],
            isBookingConfirmed: false,
            scenario: currentScenario,
            symptom: randomSymptom,   // Assigned to this specific call
            startTime: Date.now(),
            audioBuffer: [],          // Holds all audio chunks while the bot is speaking
            silenceTimer: null,       // The stopwatch waiting for silence
            hasSpoken: false,         // Tracks if the user has triggered VAD yet
            isProcessing: false,      // Tracks if the NLP pipeline is currently active
            isEnding: false           // Prevents endCall from executing twice
        });
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

            const LOUDNESS_THRESHOLD = 200;

            // 2. Clear out any previous stopwatch because the bot just spoke!
            if (rms > LOUDNESS_THRESHOLD) {
                if (callState.silenceTimer) {
                    clearTimeout(callState.silenceTimer);
                    callState.silenceTimer = null;
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
                        console.log(`\n⏳ [Silence Detected] Hospital bot finished speaking. Processing buffered audio (${fullPcmBuffer.length} bytes)...`);

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
                        const isFakeAudio = await llmService.isHallucination(transcript);

                        if (isFakeAudio) {
                            console.log(`⚠️ [Audio Filter]: LLM blocked dynamic STT hallucination: "${transcript}"`);
                            return;
                        }

                        console.log(`🤖 [Target Bot]: "${transcript}"`);
                        callState.history.push({ role: "user", content: transcript });

                        // 5. Ask OpenAI what to say back
                        const { replyText, updatedState } = await llmService.processCustomerIntent(transcript, callState);

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
                        console.log(`🧑 [AI Tester]: "${replyText}"`);
                        updatedState.history.push({ role: "assistant", content: replyText });

                        // 6. Tell Sarvam to generate TTS speech using the exact language the bot spoke
                        const replyAudioBuffer = await sarvamService.textToStream(replyText, languageCode);

                        // 7. Stream the AI's spoken reply back to Twilio WebSocket
                        const wav = new WaveFile();

                        // Sarvam TTS actually returns a complete WAV file (with RIFF headers).
                        // We must parse the buffer, otherwise fromScratch plays the headers as noise!
                        wav.fromBuffer(replyAudioBuffer);

                        // Safeguard: Force 8kHz sampling rate just in case Sarvam ignored the parameter
                        wav.toSampleRate(8000);

                        // --- VOLUME BOOST START ---
                        // Sarvam's raw PCM audio sounds quiet when compressed down to Twilio's 8-bit network.
                        // We will artificially multiply the 16-bit PCM values (maximum range -32768 to 32767) before compressing.
                        const VOLUME_MULTIPLIER = 2.5;
                        const samples = new Int16Array(wav.data.samples.buffer); // Interpret the raw bytes as 16-bit integers

                        for (let i = 0; i < samples.length; i++) {
                            // Multiply each audio frame
                            let boosted = samples[i] * VOLUME_MULTIPLIER;

                            // Prevent integer overflow (audio clipping / static)
                            if (boosted > 32767) boosted = 32767;
                            if (boosted < -32768) boosted = -32768;

                            samples[i] = boosted;
                        }
                        // --- VOLUME BOOST END ---

                        // Convert the louder 16-bit PCM WAV into Twilio's expected 8-bit mu-law encoding
                        wav.toMuLaw();

                        // Extract mu-law bytes without WAV header
                        const mulawArray = new Uint8Array(wav.data.samples);

                        // Twilio requires raw byte arrays to be chopped precisely.
                        // 320 mu-law bytes (samples) = 40ms of audio at 8000Hz.
                        const CHUNK_SIZE_BYTES = 320;
                        let offset = 0;

                        if (ws.readyState === 1) { // 1 === WebSocket.OPEN
                            const sendAudioChunks = async () => {
                                while (offset < mulawArray.length) {
                                    if (ws.readyState !== 1) break; // Stop if socket closed

                                    // 1. Slice exactly 320 bytes from the byte array
                                    const chunkBytes = mulawArray.slice(offset, offset + CHUNK_SIZE_BYTES);

                                    // 2. Convert just this exact byte array to base64
                                    const chunkBase64 = Buffer.from(chunkBytes).toString('base64');

                                    const mediaMessage = {
                                        event: "media",
                                        streamSid: ws.streamSid,
                                        media: {
                                            payload: chunkBase64
                                        }
                                    };
                                    ws.send(JSON.stringify(mediaMessage));
                                    offset += CHUNK_SIZE_BYTES;

                                    // 3. Pacing: Wait ~20ms to ensure Twilio buffer stays fed (slightly faster than real-time)
                                    await new Promise(resolve => setTimeout(resolve, 20));
                                }
                                console.log(`[Call Manager] Successfully paced and streamed all audio chunks to Twilio\n`);
                            };

                            // Kick off the async streaming process
                            sendAudioChunks();
                        } else {
                            console.log(`[Call Manager] Skipped audio reply: Twilio WebSocket is already closed.\n`);
                        }
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

            // Wait gracefully for any active STT/LLM generation or pending silence timers to finish 
            // before we package up the history for the report card! (Max 6 seconds timeout)
            let waitLoops = 0;
            while ((callState.isProcessing || callState.silenceTimer) && waitLoops < 60) {
                await new Promise(r => setTimeout(r, 100));
                waitLoops++;
            }

            console.log(`[Call Manager] Call ended: ${callSid}`);

            // Generate Test Report
            if (callState.history && callState.history.length > 0) {
                console.log(`\n📊 [Call Manager] Analyzing call history for Test Report (Scenario: ${callState.scenario})...`);
                try {
                    const report = await llmService.generateTestReport(callState.history, callState.scenario);
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
}

module.exports = new CallManager();
