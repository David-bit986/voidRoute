import fs from 'fs';
import path from 'path';

function replaceInDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      replaceInDir(fullPath);
    } else if (fullPath.endsWith('.js') || fullPath.endsWith('.mjs')) {
      let content = fs.readFileSync(fullPath, 'utf8');
      if (content.includes('"open-sse/') || content.includes("'open-sse/")) {
        content = content.replace(/(['"])open-sse\//g, '$1#open-sse/');
        fs.writeFileSync(fullPath, content);
        console.log("Updated open-sse alias in " + fullPath);
      }
    }
  }
}

replaceInDir('C:/Users/tanas/Desktop/9router-cli/src');
replaceInDir('C:/Users/tanas/Desktop/9router-cli/open-sse');
