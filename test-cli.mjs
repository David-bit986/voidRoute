import inquirer from 'inquirer';
import { manageCliTools } from './cli-ui.js';

let step = 0;
const originalPrompt = inquirer.prompt;
inquirer.prompt = async (questions) => {
  console.log('[MOCK PROMPT]', questions[0].message);
  
  if (step === 0) {
    step++;
    // Simulate selecting 'opencode'
    return { tool: 'pi' };
  } else if (step === 1) {
    step++;
    // opencode might ask whatDo if connected
    if (questions[0].name === 'whatDo') {
      return { whatDo: 'apply' };
    } else if (questions[0].name === 'modelSelection') {
      return { modelSelection: 'ag/gemini-2.5-pro' };
    }
    return {};
  } else if (step === 2) {
    step++;
    // Now it should definitely ask for model if the previous was whatDo
    if (questions[0].name === 'modelSelection') {
      return { modelSelection: 'ag/gemini-2.5-pro' };
    }
    return {};
  } else {
    // Break loop
    return { tool: 'back' };
  }
};

async function runTest() {
  console.log('Starting manageCliTools test for pi...');
  try {
    await manageCliTools(20130);
    console.log('manageCliTools test for pi completed successfully.');
  } catch (err) {
    console.error('Error during manageCliTools test:', err);
  } finally {
    process.exit(0);
  }
}

runTest();



