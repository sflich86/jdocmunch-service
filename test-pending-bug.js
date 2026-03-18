const { db } = require("./lib/db");
const crypto = require("crypto");

async function runTest() {
  const bookId = crypto.randomUUID();
  console.log("1. Ensured test book doesn't have an enrichment_job.");
  
  // Insert a mock book in 'pending' state
  await db.execute({
    sql: "INSERT INTO books (id, user_id, title, author, filename, index_status) VALUES (?, 'admin', 'Test Bug Book', 'Test', 'test_bug.md', 'pending')",
    args: [bookId]
  });
  console.log(`2. Inserted book ${bookId} with index_status='pending'`);
  
  // Call the API endpoint
  console.log("3. Calling GET /enrichment-status/" + bookId);
  try {
    const res = await fetch("http://localhost:3000/enrichment-status/" + bookId);
    console.log("   HTTP Status:", res.status);
    const data = await res.json();
    console.log("   Response Data:", data);
  } catch (err) {
    console.error("   Fetch failed. Make sure server is running on port 3000.", err.message);
    process.exit(1);
  }
  
  // Check the DB again
  const check = await db.execute({
    sql: "SELECT index_status FROM books WHERE id = ?",
    args: [bookId]
  });
  const status = check.rows[0].index_status;
  console.log(`4. DB Book status is now: '${status}'`);
  
  // Cleanup
  await db.execute({ sql: "DELETE FROM books WHERE id = ?", args: [bookId] });

  if (status === 'error') {
    console.log("✅ TEST PASSED: Auto-heal successfully updated book to 'error'.");
    process.exit(0);
  } else {
    console.error(`❌ TEST FAILED: Auto-heal did not work. Status is '${status}', expected 'error'.`);
    process.exit(1);
  }
}

runTest();
