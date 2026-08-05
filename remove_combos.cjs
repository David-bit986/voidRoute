const fs = require('fs');

// 1. Update cli-ui.js
let code = fs.readFileSync('cli-ui.js', 'utf8');
code = code.replace(/{ name: '  \\.\\.Manage Combos', value: 'combos' },\n/g, '');
code = code.replace(/getCombos, getComboByName, createCombo, updateCombo, deleteCombo,/g, '');

const combosActionStart = code.indexOf("if (action === 'combos') {");
const clitoolsActionStart = code.indexOf("if (action === 'clitools') {");
if (combosActionStart !== -1 && clitoolsActionStart !== -1) {
  code = code.substring(0, combosActionStart) + code.substring(clitoolsActionStart);
}

const manageCombosStart = code.indexOf("async function manageCombos()");
const manageCliToolsStart = code.indexOf("async function manageCliTools()");
if (manageCombosStart !== -1 && manageCliToolsStart !== -1) {
  code = code.substring(0, manageCombosStart) + code.substring(manageCliToolsStart);
}
fs.writeFileSync('cli-ui.js', code);

// 2. Update src/sse/handlers/chat.js
let chatCode = fs.readFileSync('src/sse/handlers/chat.js', 'utf8');
chatCode = chatCode.replace(/import { handleComboChat } from '\.\/combo\.js';\n/g, '');
const comboLogicStart = chatCode.indexOf("const comboModels = await getComboModels(modelStr);");
const sseStart = chatCode.indexOf("if (isSSE)");
if (comboLogicStart !== -1 && sseStart !== -1) {
  chatCode = chatCode.substring(0, comboLogicStart) + chatCode.substring(sseStart);
}
fs.writeFileSync('src/sse/handlers/chat.js', chatCode);

// 3. Update index.js
let indexCode = fs.readFileSync('index.js', 'utf8');
const comboModelsStart = indexCode.indexOf("const allCombos = await getCombos();");
const sendResponseStart = indexCode.indexOf("res.json({ object: 'list', data: modelsList });");
if (comboModelsStart !== -1 && sendResponseStart !== -1) {
  indexCode = indexCode.substring(0, comboModelsStart) + 
              "const modelsList = [];\n    // Combos removed\n    " + 
              indexCode.substring(sendResponseStart);
}
fs.writeFileSync('index.js', indexCode);

console.log('Combos successfully removed from the codebase!');
