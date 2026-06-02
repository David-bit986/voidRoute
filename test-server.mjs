import { spawn } from 'child_process';

const server = spawn('bun', ['run', 'index.js'], { stdio: 'inherit', shell: true });

// Wait a bit for server to start
setTimeout(async () => {
  console.log('Sending request to http://localhost:20130/v1/messages');
  try {
    const res = await fetch('http://localhost:20130/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hello' }]
      })
    });
    console.log('Response Status:', res.status);
    // Even if it returns 401 or 500, we just want to verify it doesn't return 404
  } catch (err) {
    console.error('Fetch error:', err);
  } finally {
    server.kill();
    process.exit(0);
  }
}, 2000);
