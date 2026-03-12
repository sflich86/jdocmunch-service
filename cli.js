#!/usr/bin/env node
const axios = require('axios');

const args = process.argv.slice(2);
const query = args.join(' ');

if (!query) {
    console.log('Usage: node cli.js <your question>');
    process.exit(1);
}

const SERVER_URL = 'http://localhost:3000';

async function search() {
    console.log(`\n🔍 Searching for: "${query}"...`);
    const start = Date.now();
    try {
        const response = await axios.get(`${SERVER_URL}/search`, { params: { q: query } });
        const totalTime = Date.now() - start;

        console.log(`✅ Results found: ${response.data.result_count}`);
        console.log(`⏱️  Total Session Latency: ${totalTime}ms`);
        console.log(`⚡ jDocMunch Internal Latency: ${response.data.service_latency_ms}ms`);
        console.log('-----------------------------------');
        
        if (response.data.results && response.data.results.length > 0) {
            response.data.results.forEach((res, i) => {
                console.log(`[${i+1}] ${res.title}`);
                console.log(`    ID: ${res.id}\n`);
            });
        } else {
            console.log('No specific sections matches found in the index.');
        }
    } catch (err) {
        console.error('❌ Error connecting to service. Make sure server.js is running.');
        console.error(err.message);
    }
}

search();
