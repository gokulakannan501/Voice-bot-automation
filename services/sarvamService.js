const axios = require('axios');
const FormData = require('form-data');

class SarvamService {
    constructor() {
        this.apiKey = process.env.SARVAM_API_KEY;
        this.baseUrl = 'https://api.sarvam.ai';
    }

    /**
     * Converts raw audio stream from Exotel into Text (STT)
     * @param {Buffer} audioBuffer - the raw audio bytes
     * @returns {Promise<{text: string, languageCode: string}>} - The transcribed text and detected language code
     */
    async streamToText(audioBuffer) {
        try {
            console.log('[Sarvam] Transcribing audio chunk...');
            const formData = new FormData();

            // Ensure it is a true Node Buffer (since wavefile.toBuffer returns a Uint8Array)
            const nodeBuffer = Buffer.from(audioBuffer);

            // Mocking a filename for the buffer as Sarvam expects a file upload
            formData.append('file', nodeBuffer, { filename: 'audio.wav', contentType: 'audio/wav' });
            formData.append('model', 'saarika:v2.5');

            const response = await axios.post(`${this.baseUrl}/speech-to-text`, formData, {
                headers: {
                    ...formData.getHeaders(),
                    'api-subscription-key': this.apiKey,
                },
            });

            console.log('[Sarvam] Raw API Response:', JSON.stringify(response.data));

            // The Sarvam v1 schema used .transcript, but newer versions might use .text
            const resultText = response.data.transcript || response.data.text || "";
            const languageCode = response.data.language_code || "en-IN";

            return {
                text: resultText.trim(),
                languageCode: languageCode
            };
        } catch (error) {
            console.error('[Sarvam] STT Error:', error.response?.data || error.message);
            return { text: "", languageCode: "en-IN" };
        }
    }

    /**
     * Converts bot text response into raw audio stream for Exotel (TTS)
     * @param {string} text - The text to speak
     * @param {string} targetLanguageName - The english name of the language (e.g., 'Tamil')
     * @returns {Promise<Buffer>} - The audio bytes
     */
    async textToStream(text, targetLanguageName = "English") {
        try {
            const languageCodeMap = {
                'English': 'en-IN',
                'Hindi': 'hi-IN',
                'Tamil': 'ta-IN',
                'Telugu': 'te-IN',
                'Kannada': 'kn-IN',
                'Marathi': 'mr-IN',
                'Gujarati': 'gu-IN'
            };

            const targetLanguageCode = languageCodeMap[targetLanguageName] || 'en-IN';

            console.log(`[Sarvam] Generating speech for: "${text}" in ${targetLanguageName} (${targetLanguageCode})`);

            const payload = {
                inputs: [text],
                target_language_code: targetLanguageCode,
                speaker: "rahul",
                pace: 1.1,                   // Slightly faster pace
                speech_sample_rate: 8000,    // EXOTEL CRITICAL: Must remain 8kHz
                enable_preprocessing: true,
                model: "bulbul:v3"
            };

            const response = await axios.post(`${this.baseUrl}/text-to-speech`, payload, {
                headers: {
                    'Content-Type': 'application/json',
                    'api-subscription-key': this.apiKey,
                }
            });

            // Sarvam TTS returns base64 string in 'audios' array
            const base64Audio = response.data.audios[0];
            return Buffer.from(base64Audio, 'base64');

        } catch (error) {
            console.error('[Sarvam] TTS Error:', error.response?.data || error.message);
            return Buffer.from([]);
        }
    }
}

module.exports = new SarvamService();
