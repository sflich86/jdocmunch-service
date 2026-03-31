const axios = require('axios');

async function run() {
  const base = 'https://ssjdocmunchss.odontolab.co';
  const payload = {
    query: "que es la claridad?",
    user_id: "bac626b6-71e7-4a8c-9834-3c7c891a5fa2", // ID from portainer logs
    book_ids: [] 
  };
  
  try {
    const res = await axios.post(`${base}/api/jdocmunch/search`, payload);
    console.log("Status:", res.status);
    console.log("Found Chunks:", res.data.chunks?.length || 0);
    console.log(JSON.stringify(res.data, null, 2).slice(0, 1000)); 
  } catch (e) {
    console.error("Error:", e.message);
    if (e.response) {
       console.error(e.response.data);
    }
  }
}
run();
