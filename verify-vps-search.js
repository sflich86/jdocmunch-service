const axios = require('axios');

async function probe(url) {
  console.log(`Probing: ${url}`);
  try {
    const res = await axios.get(url);
    console.log(`  SUCCESS: ${url} -> ${res.status}`);
    return true;
  } catch (e) {
    console.log(`  FAIL: ${url} -> ${e.response?.status || e.message}`);
    return false;
  }
}

async function testVpsSearch() {
  const base = 'https://ssjdocmunchss.odontolab.co';
  
  await probe(`${base}/health`);
  await probe(`${base}/api/jdocmunch/health`);
  await probe(`${base}/search`);
  await probe(`${base}/api/search`);
  await probe(`${base}/api/jdocmunch/search`); 

  // Try them as POST too
  console.log("\nProbing POST...");
  const payload = { user_id: 'admin', query: 'test' };
  try { 
    await axios.post(`${base}/api/jdocmunch/search`, payload); 
    console.log("POST /api/jdocmunch/search OK"); 
  } catch(e) { 
    console.log(`POST /api/jdocmunch/search FAIL: ${e.response?.status}`); 
  }
  
  try { 
    await axios.post(`${base}/search`, payload); 
    console.log("POST /search OK"); 
  } catch(e) { 
    console.log(`POST /search FAIL: ${e.response?.status}`); 
  }
}

testVpsSearch();
