import fs from 'fs';
import path from 'path';

const SRC_DIR = 'C:/Users/tanas/Desktop/9router';
const DEST_DIR = 'C:/Users/tanas/Desktop/9router-cli';

function copyDir(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      // Exclude frontend and Next.js specific directories
      if (['.next', 'node_modules', 'public', 'images', 'app', 'docs', 'gitbook', 'tester', 'tests'].includes(entry.name)) continue;
      // In src, exclude app (which has the Next.js routes) and dashboardGuard
      if (src.endsWith('src') && ['app', 'dashboardGuard.js'].includes(entry.name)) continue;
      
      copyDir(srcPath, destPath);
    } else {
      // Exclude UI files
      if (['page.js', 'layout.js', 'globals.css', 'favicon.ico'].includes(entry.name)) continue;
      
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

console.log('Extracting backend directories...');
['open-sse', 'src/lib', 'src/sse', 'src/models', 'src/shared'].forEach(dir => {
  const src = path.join(SRC_DIR, dir);
  const dest = path.join(DEST_DIR, dir);
  if (fs.existsSync(src)) {
    copyDir(src, dest);
    console.log(`Copied ${dir}`);
  }
});

// Create package.json
const pkgPath = path.join(SRC_DIR, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

const newPkg = {
  name: '9router-cli',
  version: '1.0.0',
  type: 'module',
  main: 'index.js',
  scripts: {
    start: 'node index.js'
  },
  dependencies: {
    "express": "^4.19.2",
    "cors": "^2.8.5",
    "dotenv": "^16.4.5",
    "inquirer": "^9.2.22",
    "chalk": "^5.3.0",
    "module-alias": "^2.2.3",
    "better-sqlite3": "^11.1.2",
    "uuid": "^10.0.0",
    "bcryptjs": "^2.4.3",
    "jose": "^5.6.3",
    "undici": "^6.19.2",
    "node-machine-id": "^1.1.12",
    "node-forge": "^1.3.1"
  }
};

fs.writeFileSync(path.join(DEST_DIR, 'package.json'), JSON.stringify(newPkg, null, 2));
console.log('Created package.json');

// Write module-alias setup and Express proxy
const indexJs = `
import 'module-alias/register.js';
import moduleAlias from 'module-alias';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Mock Next.js and alias @ to src
moduleAlias.addAliases({
  '@': path.join(__dirname, 'src')
});

import express from 'express';
import cors from 'cors';
import { handleChat } from './src/sse/handlers/chat.js';
import { initTranslators } from './open-sse/translator/index.js';
import { setupCLI } from './cli-ui.js';

const app = express();
app.use(cors());
// Parse body as text first to avoid express body-parser tampering with SSE/Fetch streams easily, 
// or just use json but carefully. We will use a custom raw parser or express.json.
app.use(express.json({ limit: '50mb' }));

// Fake NextRequest object for the handlers
function createNextRequest(req) {
  const url = new URL(req.originalUrl, \`http://\${req.headers.host}\`);
  return {
    url: url.toString(),
    method: req.method,
    headers: new Headers(req.headers),
    json: async () => req.body,
    text: async () => JSON.stringify(req.body)
  };
}

app.post('/v1/chat/completions', async (req, res) => {
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
  const PORT = process.env.PORT || 20128;
  app.listen(PORT, () => {
    // Start CLI
    setupCLI(PORT);
  });
}

start();
`;

fs.writeFileSync(path.join(DEST_DIR, 'index.js'), indexJs);
console.log('Created index.js');

const cliUiJs = `
import inquirer from 'inquirer';
import chalk from 'chalk';
import { getSettings } from './src/lib/localDb.js';

export async function setupCLI(port) {
  console.clear();
  console.log(chalk.blue.bold('🚀 9Router CLI Edition'));
  console.log(chalk.gray(\`Proxy Server running at http://localhost:\${port}/v1\`));
  
  while(true) {
    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'Main Menu:',
        choices: [
          { name: '🌐 Manage Providers', value: 'providers' },
          { name: '🔄 Server Status', value: 'status' },
          { name: '❌ Exit', value: 'exit' }
        ]
      }
    ]);

    if (action === 'exit') {
      process.exit(0);
    } else if (action === 'status') {
      const settings = await getSettings();
      console.log(chalk.green('\\n--- Server Status ---'));
      console.log(\`Endpoint: http://localhost:\${port}/v1\`);
      console.log(\`RTK Token Saver: \${settings.rtkEnabled ? 'ON' : 'OFF'}\`);
      console.log('---------------------\\n');
    } else if (action === 'providers') {
      console.log(chalk.yellow('Provider management is under construction in CLI mode...'));
      // We will implement direct SQLite access here
    }
  }
}
`;

fs.writeFileSync(path.join(DEST_DIR, 'cli-ui.js'), cliUiJs);
console.log('Created cli-ui.js');
