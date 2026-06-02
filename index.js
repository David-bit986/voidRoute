import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import express from 'express';
import cors from 'cors';
import { handleChat } from './src/sse/handlers/chat.js';
import { initTranslators } from '#open-sse/translator/index.js';
import { setupCLI } from './cli-ui.js';

const app = express();
app.use(cors());
// Parse body as text first to avoid express body-parser tampering with SSE/Fetch streams easily, 
// or just use json but carefully. We will use a custom raw parser or express.json.
app.use(express.json({ limit: '50mb' }));

// Fake NextRequest object for the handlers
function createNextRequest(req) {
  const url = new URL(req.originalUrl, `http://${req.headers.host}`);
  return {
    url: url.toString(),
    method: req.method,
    headers: new Headers(req.headers),
    json: async () => req.body,
    text: async () => JSON.stringify(req.body)
  };
}

app.post(['/v1/chat/completions', '/v1/messages'], async (req, res) => {
  try {
    const nextReq = createNextRequest(req);
    const response = await handleChat(nextReq, {
      endpoint: req.originalUrl,
      body: req.body,
      headers: req.headers
    });
    
    // Copy headers from standard Response to Express res
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });
    res.status(response.status);
    
    if (response.body) {
      // ReadableStream to Node stream
      const reader = response.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            res.end();
            break;
          }
          res.write(value);
        }
      };
      await pump();
    } else {
      const text = await response.text();
      res.send(text);
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

async function start() {
  await initTranslators();
  const PORT = process.env.PORT || 20130;
  app.listen(PORT, () => {
    // Start CLI
    setupCLI(PORT);
  });
}

start();
