import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, saveConfig, CONFIG_FILE } from './config';
import { createHttpServer } from './http/server';
import { Network } from './network';

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const dataDir = resolve(argValue('--data') ?? process.env.MCNETWORK_DATA ?? 'data');
  mkdirSync(dataDir, { recursive: true });
  const config = loadConfig(dataDir);
  if (argValue('--port')) config.http.port = Number(argValue('--port'));
  saveConfig(dataDir, config); // writes the defaults on the first run so they can be edited

  const network = new Network(dataDir, config);
  const http = createHttpServer(network, config.http);
  const port = await http.listen();
  console.log(`MCNetwork API on http://${config.http.host}:${port} (data: ${dataDir}, config: ${CONFIG_FILE})`);
  await network.start();
  console.log(`Network started: ${config.servers.length} server(s).`);

  let quitting = false;
  const quit = () => {
    if (quitting) process.exit(1);
    quitting = true;
    console.log('Stopping all servers...');
    void network
      .stop()
      .then(() => http.close())
      .then(() => process.exit(0));
  };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
