require('dotenv').config();
const llmService = require('../services/llmService');

async function runTests() {
    console.log("🚀 Starting LLM Service Unit Tests...\n");

    let mockCallState = {
        history: [],
        isBookingConfirmed: false,
        startTime: Date.now()
    };

    // Simulate what the Clinic's Voice Bot asks our AI User
    const transcriptsToTest = [
        "Welcome to Exotel Clinic. How can I help you today?",
        "I can help with that. Are you an existing patient, and what is your name?",
        "Thank you Rahul. When would you like to book this appointment?"
    ];

    for (const transcript of transcriptsToTest) {
        console.log(`\n🗣️  User: "${transcript}"`);

        const result = await llmService.processCustomerIntent(transcript, mockCallState);

        console.log(`🤖 Bot: "${result.replyText}"`);

        // Update state logic simulating the CallManager
        mockCallState = result.updatedState;
        mockCallState.history.push({ role: "user", content: transcript });
        mockCallState.history.push({ role: "assistant", content: result.replyText });
    }

    console.log("\n✅ LLM Integration Test Complete.");
    console.log("Final Call State History:");
    console.log(JSON.stringify(mockCallState.history, null, 2));
}

runTests();
