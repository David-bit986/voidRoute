import fs from 'fs';
import path from 'path';
import os from 'os';

export class BaseAdapter {
  constructor(toolName, displayName) {
    this.toolName = toolName;
    this.displayName = displayName;
  }

  resolveConfigPath() { return []; }
  getConfigPath() {
    const paths = this.resolveConfigPath();
    const found = paths.find(p => fs.existsSync(path.dirname(p)));
    return found || paths[0];
  }

  detectStatus() { return null; }
  
  applyConfig(model, endpoint, endpointNoV1, providerModelsList, allModelsForProvider, defaultModelForTool, allModelsForPi, isCustomModel) {
    throw new Error('Not implemented');
  }

  resetConfig() {
    throw new Error('Not implemented');
  }
}
