// `npm run check`: reports Ollama status, required models and a live test reply.
import { runCheck } from '../app/core/check.js';

process.exitCode = await runCheck();
