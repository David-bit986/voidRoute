import { EventEmitter } from "events";
import { CONSOLE_LOG_CONFIG } from "#shared/constants/config.js";

if (!global._consoleLogBufferState) {
  global._consoleLogBufferState = {
    logs: [],
    emitter: new EventEmitter(),
  };
  global._consoleLogBufferState.emitter.setMaxListeners(50);
}

const state = global._consoleLogBufferState;

// Strip ANSI escape codes if needed for UI, but keeping colors for terminal is usually better
// For now, we will just store exactly what is passed.
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

export function appendLogLine(line) {
  state.logs.push(line);
  const maxLines = CONSOLE_LOG_CONFIG.maxLines;
  if (state.logs.length > maxLines) {
    state.logs = state.logs.slice(-maxLines);
  }
  state.emitter.emit("line", line);
  
  // Only print to stdout if TUI is not actively waiting for input
  if (!global.TUI_ACTIVE) {
    process.stdout.write(line + "\n");
  }
}

// We no longer patch console.log globally to avoid capturing UI/inquirer prompts.
export function initConsoleLogCapture() {
  // No-op. We route directly from logger.js now.
}

export function getConsoleLogs() {
  return state.logs;
}

export function clearConsoleLogs() {
  state.logs = [];
  state.emitter.emit("clear");
}

export function getConsoleEmitter() {
  return state.emitter;
}
