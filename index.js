import { handleChat } from './src/sse/handlers/chat.js';
import { handleEmbeddings } from './src/sse/handlers/embeddings.js';
import { handleFetch } from './src/sse/handlers/fetch.js';
import { handleSearch } from './src/sse/handlers/search.js';
import { handleImageGeneration } from './src/sse/handlers/imageGeneration.js';
import { handleStt } from './src/sse/handlers/stt.js';
import { handleTts } from './src/sse/handlers/tts.js';
import { initTranslators } from '#open-sse/translator/index.js';
import { setupCLI } from './cli-ui.js';
import { initConsoleLogCapture } from './src/lib/consoleLogBuffer.js';
import { createNativeRequestHandler, startNativeServer } from './src/server/transport.js';
import { getModels } from './src/server/model-list.js';

const SERVER_HOSTNAME = process.env.VOIDROUTE_HOST?.trim() || process.env.HOST?.trim() || '127.0.0.1';
const SERVER_AUTH_TOKEN = process.env.OPENCODEX_API_AUTH_TOKEN?.trim() || '';

const requestHandler = createNativeRequestHandler({
  handleChat,
  getModels,
  hostname: SERVER_HOSTNAME,
  authToken: SERVER_AUTH_TOKEN,
  handlers: {
    embeddings: handleEmbeddings,
    fetch: handleFetch,
    search: handleSearch,
    imageGeneration: handleImageGeneration,
    stt: handleStt,
    tts: handleTts,
  },
});

async function runCodexListeningHook() {
  // Startup may refresh/repair a validated, owned lifecycle generation.
  const { CodexLifecycle } = await import('./src/lib/cli-config/CodexLifecycle.js');
  const { getProviderNodes } = await import('./src/lib/db/index.js');
  const providerNodes = await getProviderNodes();
  const result = new CodexLifecycle().repairCatalogNow({ providerNodes });
  if (result.repaired) {
    console.log('  ℹ️  Repaired Codex model catalog/cache (natives + selected routed).');
  } else if (result.refreshed) {
    console.log('  ℹ️  Refreshed Codex models cache (models_cache.json).');
  }
}

function reportStartupFailure(stage, error) {
  console.error(`[Startup] ${stage} failed:`, error);
}

async function start() {
  initConsoleLogCapture();
  await initTranslators();
  const { hydrateSyncedModels } = await import('./src/lib/modelSync.js');
  await hydrateSyncedModels();
  const PORT = Number.parseInt(process.env.PORT || '20130', 10);
  try {
    startNativeServer({
      port: PORT,
      hostname: SERVER_HOSTNAME,
      authToken: SERVER_AUTH_TOKEN,
      fetch: requestHandler,
      onListening: () => {
        // Start CLI after Bun has bound the public transport.
        try {
          void setupCLI(PORT).catch((error) => reportStartupFailure('CLI setup', error));
        } catch (error) {
          reportStartupFailure('CLI setup', error);
          throw error;
        }
        void runCodexListeningHook().catch((error) => reportStartupFailure('Codex listening hook', error));
      },
    });
  } catch (err) {
    if (err?.code === 'EADDRINUSE' || /address already in use/i.test(err?.message || '')) {
      console.error(`\n  ❌ Port ${PORT} is already in use.`);
      console.error('     Another voidRoute instance is already running.');
      console.error('     Close it (or that window) and try again.\n');
    } else {
      console.error(err);
    }
    process.exit(1);
  }
}

start().catch((error) => {
  reportStartupFailure('initialization', error);
  process.exitCode = 1;
});
