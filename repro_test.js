const axios = require('axios');
const assert = require('assert');

async function testSemanticSearch() {
    const baseUrl = 'https://ssjdocmunchss.odontolab.co';
    const query = 'miedo';
    const userId = 'admin';

    console.log(`Testing semantic search for user "${userId}" with query "${query}"...`);

    try {
        // 1. Test POST /api/jdocmunch/search
        console.log(`\n--- Testing POST /api/jdocmunch/search ---`);
        try {
            const searchRes = await axios.post(`${baseUrl}/api/jdocmunch/search`, {
                query: query,
                user_id: userId
            });
            console.log('Search response received (Status:', searchRes.status, ')');
            
            const candidates = searchRes.data.candidates || [];
            console.log(`Found ${candidates.length} candidates.`);
            if (candidates.length > 0 && (candidates[0].text || candidates[0].content)) {
                console.log('✅ SUCCESS: POST search returned valid content.');
            } else if (candidates.length > 0) {
                console.error('❌ STILL BUGGY: candidate text/content is empty.');
            }
        } catch (e) {
            console.error('❌ POST search failed:', e.message);
        }

        // 2. Test GET /ask
        console.log(`\n--- Testing GET /ask ---`);
        const askRes = await axios.get(`${baseUrl}/ask`, {
            params: { q: query, user_id: userId }
        });

        console.log('Ask response:', JSON.stringify(askRes.data, null, 2));
        if (askRes.data.answer && askRes.data.answer.includes('undefined')) {
            console.error('❌ BUG STILL PRESENT: /ask response contains "undefined".');
        } else {
            console.log('✅ SUCCESS: /ask returned a valid answer.');
        }

    } catch (err) {
        console.error('Test failed with error:', err.message);
        if (err.response) {
            console.error('Response status:', err.response.status);
            console.error('Response data:', err.response.data);
        }
    }
}

testSemanticSearch();
