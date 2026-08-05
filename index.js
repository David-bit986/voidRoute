import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import express from 'express';
import cors from 'cors';
import { handleChat } from './src/sse/handlers/chat.js';
import { initTranslators } from '#open-sse/translator/index.js';
import { setupCLI } from './cli-ui.js';
import { initConsoleLogCapture } from './src/lib/consoleLogBuffer.js';

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

app.get('/v1/models', async (req, res) => {
  try {
    const { getProviderConnections } = await import('#lib/localDb.js');
    const { getModelsByProviderId, PROVIDER_ID_TO_ALIAS } = await import('./open-sse/config/providerModels.js');
    
    const connections = await getProviderConnections();
    const modelsList = [];
    
    for (const conn of connections) {
      const pid = conn.provider || conn.providerId;
      const alias = PROVIDER_ID_TO_ALIAS[pid] || pid;
      const list = getModelsByProviderId(pid);
      if (list && list.length > 0) {
        for (const m of list) {
          if (m.type === 'image' || m.type === 'embedding' || m.type === 'tts' || m.type === 'stt') continue;
          const modelId = typeof m === 'string' ? m : m.id;
          const id = alias ? `${alias}/${modelId}` : modelId;
          if (!modelsList.find(x => x.id === id)) {
            modelsList.push({ id, object: 'model', created: Date.now(), owned_by: 'voidRoute' });
          }
        }
      }
    }
    
    res.json({ object: 'list', data: modelsList });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post(['/v1/chat/completions', '/v1/messages', '/v1/responses'], async (req, res) => {
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
  initConsoleLogCapture();
  await initTranslators();
  const PORT = process.env.PORT || 20130;
  app.listen(PORT, () => {
    // Start CLI
    setupCLI(PORT);
  });
}

start();
