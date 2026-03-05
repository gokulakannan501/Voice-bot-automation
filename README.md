# AI Voice & WhatsApp Bot NLP Auto-Tester

A comprehensive testing suite for verifying Medical/Hospital Voice Bots and WhatsApp Bots. This system acts as a "Human-in-the-Loop" or "Autonomous" AI tester that simulates patient scenarios (Self, Wife, Mother, Father) to evaluate the NLP accuracy of the target bot.

## 📁 Project Structure

*   `server.js`: Main Express & WebSocket server. Handles orchestration.
*   `public/`: Dashboard UI and static assets.
*   `engine/`: 
    *   `callManager.js`: Manages Voice Call states and Sarvam/OpenAI flows.
    *   `chatManager.js`: Manages WhatsApp session states and Twilio Messaging.
*   `services/`:
    *   `llmService.js`: Reasoning engine (OpenAI GPT-4o) with dynamic personas.
    *   `sarvamService.js`: Integration for Sarvam v3 (STT: Saaras, TTS: Bulbul).
*   `tests/`: Utility scripts for unit testing and logic verification.
*   `test_call_twilio.js`: Helper script to initiate outbound Twilio calls for testing.

## 🚀 Getting Started

### 1. Prerequisites
*   [Node.js](https://nodejs.org/) (v16+)
*   [Ngrok](https://ngrok.com/) (For webhook tunneling)

### 2. Installation
```bash
npm install
```

### 3. Configuration
1.  Copy `.env.example` to `.env`.
2.  Fill in your API Keys for **Sarvam AI**, **Twilio**, and **OpenAI**.
3.  Set your `TARGET_BOT_NUMBER` (the number of the bot you want to test).

### 4. Running the Dashboard
1.  In one terminal, start Ngrok:
    ```bash
    ngrok http 4001
    ```
2.  In another terminal, start the server:
    ```bash
    node server.js
    ```
3.  Open `http://localhost:4001` in your browser.

## 🧪 Testing Scenarios
Choose a **Persona** from the dashboard:
*   **Self**: High-priority account holder (Gokulakannan).
*   **Wife**: Booking for themselves via the primary number.
*   **Mother**: Calling to book for a child (Aryan, age 5).
*   **Father**: Son calling to book for an elderly father (Ashok, age 70).

The system automatically adjusts its **Voice (Male/Female)** and **LLM Prompting** based on the selected persona.

## 🛠 Tech Stack
*   **Telephony**: Twilio (Voice & Programmable Messaging)
*   **STT/TTS**: Sarvam AI (v3)
*   **LLM**: OpenAI (GPT-4o)
*   **Backend**: Node.js, Express, WebSocket (WS)
