import { app } from './app';
import { env } from './config/env';
import { startRemindersWorker } from './worker/reminders.worker';

app.listen(env.port, () => {
  console.log(`Taskeer API escuchando en http://localhost:${env.port}`);
});

// Worker de recordatorios in-process — simplificación temporal mientras se
// sigue en Render free tier, ver docs/01-arquitectura.md, "Simplificación
// temporal: polling in-process en la misma API".
startRemindersWorker();
