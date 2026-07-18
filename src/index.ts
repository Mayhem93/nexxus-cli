#!/usr/bin/env node
import {
  NexxusConfigManager,
  NexxusBaseLogger,
  FatalErrorException,
  type INexxusBaseServices,
} from '@mayhem93/nexxus-core-lib';
import type { NexxusDatabaseAdapter } from '@mayhem93/nexxus-database-lib';
import type { NexxusMessageQueueAdapter } from '@mayhem93/nexxus-message-queue-lib';

import { NexxusCli, type NexxusCliConfig } from './lib/NexxusCli.ts';

import { existsSync } from 'node:fs';

// Set once the logger is resolved, so the top-level catch can log fatals through
// it; until then (or if we fail earlier) we fall back to console.
let logger: NexxusBaseLogger<any> | undefined;

async function main(): Promise<void> {
  // 1. Resolve the command from argv first. No config or services needed, so
  //    `--help` / usage errors work without a config file or a reachable DB.
  const invocation = NexxusCli.parseArgs();

  // 2. A real command was resolved — compose services, mirroring the reference
  //    runnables' index.ts. The CLI parser handled <command>/<subcommand>; config
  //    values (NXX_DB_HOST, ...) are the ConfigManager's concern from here on.
  if (!existsSync(NexxusCli.CONFIG_PATH)) {
    throw new FatalErrorException(
      `Nexxus CLI config not found at ${NexxusCli.CONFIG_PATH}. Create it before running this command.`
    );
  }

  const configManager = new NexxusConfigManager(NexxusCli.CONFIG_PATH);

  // Register NexxusCli (it owns the 'app' key) so app.logger / app.database become readable.
  await configManager.validateServices([NexxusCli]);
  const cliConfig = configManager.getConfig('app') as NexxusCliConfig;

  const LoggerClass = await NexxusCli.resolveFactoryService(configManager, cliConfig.logger);
  const DbClass = await NexxusCli.resolveConstructableService(configManager, cliConfig.database);
  const MqClass = await NexxusCli.resolveConstructableService(configManager, cliConfig.message_queue);

  // Validate again now that the logger + database schemas are registered.
  await configManager.validateServices();

  // Logger services intentionally have no `logger` dependency, so cast at this one site.
  const loggerInstance = await LoggerClass.create({ configManager } as INexxusBaseServices);

  if (!(loggerInstance instanceof NexxusBaseLogger)) {
    throw new FatalErrorException(`Class resolved for "${cliConfig.logger}" did not produce a NexxusBaseLogger instance.`);
  }

  logger = loggerInstance;

  const db = new DbClass({ configManager, logger }) as NexxusDatabaseAdapter<any, any>;
  const mq = new MqClass({ configManager, logger }) as NexxusMessageQueueAdapter<any, any, any>;
  const cli = new NexxusCli({ configManager, logger, database: db, message_queue: mq });

  // 3. Connect, run the resolved command, disconnect.
  await cli.init(invocation);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);

  if (logger) {
    logger.error(message, NexxusCli.loggerLabel);
  } else {
    console.error(message);
  }

  if (err instanceof FatalErrorException) {
    process.exit(1);
  }

  throw err;
});
