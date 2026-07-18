import {
  NexxusBaseService,
  NexxusBaseLogger,
  FatalErrorException,
  WinstonNexxusLogger,
  resolveConstructableServiceClass,
  resolveFactoryServiceClass,
  type ConfigCliArgs,
  type ConfigEnvVars,
  type NexxusConfig,
  type NexxusConfigManager,
  type NexxusConstructableServiceClass,
  type NexxusFactoryServiceClass,
} from '@mayhem93/nexxus-core-lib';
import { NexxusDatabaseAdapter, NexxusElasticsearchDb } from '@mayhem93/nexxus-database-lib';
import { NexxusMessageQueueAdapter, NexxusRabbitMq } from '@mayhem93/nexxus-message-queue-lib';

import { BootstrapCommand } from '../commands/BootstrapCommand.ts';
import { AppCommand } from '../commands/AppCommand.ts';
import type { AnyMessageQueueAdapter, AnyNexxusDatabaseAdapter, CliServices, Command, ParsedInvocation } from '../cli/Command.ts';

import { ArgumentParser } from 'argparse';

import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type NexxusCliConfig = NexxusConfig & {
  logger: string;
  database: string;
  message_queue: string;
};

/**
 * The CLI's main service — counterpart to `NexxusApi` / `NexxusHubApi` /
 * `NexxusWriterWorker`. It extends `NexxusBaseService` so it plugs fully into
 * `NexxusConfigManager` (owning the `app` config key via the statics below,
 * which is what makes `getConfig('app')` expose `app.logger` / `app.database`),
 * and it carries the same builtins + resolve helpers as the reference runnables.
 *
 * Two phases, split so `--help` / usage work without a config file or DB:
 *   - `parseArgs()` (static) resolves <command>/<subcommand> off process.argv,
 *     needing no config or services.
 *   - `init()` (instance, after `index.ts` composes services) connects the DB,
 *     runs the resolved command, and disconnects.
 */
export class NexxusCli extends NexxusBaseService<NexxusCliConfig> {
  public static readonly CONFIG_PATH: string = path.join(os.homedir(), '.nexxus', 'cli.conf.json');
  public static readonly loggerLabel: Readonly<string> = 'NxxCli';

  protected static configRootKey: string = 'app';
  // Resolved relative to the compiled file (dist/lib/NexxusCli.js) -> dist/schemas/app.schema.json.
  protected static schemaPath: string = path.join(import.meta.dirname, '../schemas/app.schema.json');
  protected static cliArgs: ConfigCliArgs = [];
  protected static envVars: ConfigEnvVars = [];

  // Builtin service maps — same surface as NexxusApi / NexxusBaseWorker.
  private static readonly builtinFactoryServices: Record<string, NexxusFactoryServiceClass> = {
    [WinstonNexxusLogger.name]: WinstonNexxusLogger,
  };

  private static readonly builtinConstructableServices: Record<string, NexxusConstructableServiceClass> = {
    [NexxusElasticsearchDb.name]: NexxusElasticsearchDb,
    [NexxusRabbitMq.name]: NexxusRabbitMq,
  };

  // The CLI's own command surface. Registered by `parseArgs`; owns only
  // <command>/<subcommand> — config values are the ConfigManager's concern.
  private static readonly commands: readonly Command<any>[] = [new BootstrapCommand(), new AppCommand()];

  private readonly configManager: NexxusConfigManager;
  private readonly logger: NexxusBaseLogger<any>;
  private readonly database: AnyNexxusDatabaseAdapter;
  private readonly message_queue: AnyMessageQueueAdapter;

  constructor(services: CliServices) {
    super(services.configManager.getConfig('app') as NexxusCliConfig);

    if (!(services.logger instanceof NexxusBaseLogger)) {
      throw new FatalErrorException('Logger service is not an instance of NexxusBaseLogger');
    }

    if (!(services.database instanceof NexxusDatabaseAdapter)) {
      throw new FatalErrorException('Database service is not an instance of NexxusDatabaseAdapter');
    }

    if (!(services.message_queue instanceof NexxusMessageQueueAdapter)) {
      throw new FatalErrorException('Message queue service is not an instance of NexxusMessageQueueAdapter');
    }

    this.configManager = services.configManager;
    this.logger = services.logger;
    this.database = services.database;
    this.message_queue = services.message_queue;
  }

  /**
   * Resolves the target command from `process.argv`. Runs before any config or
   * services exist, so argparse can self-exit(2) on `--help` / usage errors
   * without touching a config file or the DB.
   */
  public static parseArgs(): ParsedInvocation {
    const args = NexxusCli.buildParser().parse_args();
    const handler = args.handler as Command<any> | undefined;

    if (!handler) {
      throw new FatalErrorException('No command handler resolved.');
    }

    return { handler, args };
  }

  /**
   * Connects the DB, runs the already-resolved command, then disconnects.
   * Called by `index.ts` once services are composed.
   */
  public async init({ handler, args }: ParsedInvocation): Promise<void> {
    // TODO(v1): connection lifecycle is coarse — the DB is connected for EVERY command
    // even when unused (e.g. `bootstrap message-queue`). The message-queue adapter is
    // deliberately NOT connected here: its bootstrapper runs over the HTTP management
    // API and creates the vhost that `connect()` would otherwise require, so connecting
    // it up-front would deadlock `bootstrap message-queue`. Replace with per-command
    // connection declaration later.
    await this.database.connect();

    try {
      await handler.execute({
        args,
        configManager: this.configManager,
        logger: this.logger,
        database: this.database,
        message_queue: this.message_queue,
      });
    } finally {
      await this.database.disconnect();
    }
  }

  // Required by the abstract base. The CLI is short-lived and runs no
  // management server, so it reports no stats.
  public getStats(): Promise<Record<string, unknown>> {
    return Promise.resolve({});
  }

  private static buildParser(): ArgumentParser {
    const parser = new ArgumentParser({
      prog: 'nexxus-cli',
      description: 'Nexxus CLI — bootstrap and administer Nexxus services.'
    });

    parser.add_argument('--version', { action: 'version', version: NexxusCli.readVersion() });

    const commandParsers = parser.add_subparsers({ dest: 'command', required: true, metavar: '<command>' });

    for (const command of NexxusCli.commands) {
      command.register(commandParsers);
    }

    return parser;
  }

  /** Reads the CLI version from package.json (two levels up: dist/lib -> package root). */
  private static readVersion(): string {
    const pkg = JSON.parse(readFileSync(path.join(import.meta.dirname, '../../package.json'), 'utf8')) as {
      version: string;
    };

    return pkg.version;
  }

  /**
   * Resolves + registers a factory-style service (the logger). Builtin names
   * resolve directly; anything else is dynamic-imported from node_modules.
   */
  public static async resolveFactoryService(
    configManager: NexxusConfigManager,
    configuredName: string
  ): Promise<NexxusFactoryServiceClass> {
    const cls = await resolveFactoryServiceClass(configuredName, NexxusCli.builtinFactoryServices);

    configManager.registerService(cls);

    return cls;
  }

  /**
   * Resolves + registers a constructable service (the database adapter). Same
   * lookup-then-import shape as `resolveFactoryService`.
   */
  public static async resolveConstructableService(
    configManager: NexxusConfigManager,
    configuredName: string
  ): Promise<NexxusConstructableServiceClass> {
    const cls = await resolveConstructableServiceClass(configuredName, NexxusCli.builtinConstructableServices);

    configManager.registerService(cls);

    return cls;
  }
}
