import type { ArgumentParser, SubParser } from 'argparse';
import type { NexxusConfigManager, NexxusBaseLogger } from '@mayhem93/nexxus-core-lib';
import type { NexxusDatabaseAdapter } from '@mayhem93/nexxus-database-lib';
import type { NexxusMessageQueueAdapter } from '@mayhem93/nexxus-message-queue-lib';

/**
 * Adapters with their generic parameters erased — the concrete classes are
 * resolved from config at runtime, so the exact generics aren't known
 * statically. These aliases keep that `any` boundary in one documented place.
 */
export type AnyNexxusDatabaseAdapter = NexxusDatabaseAdapter<any, any>;
export type AnyMessageQueueAdapter = NexxusMessageQueueAdapter<any, any, any>;

/**
 * The services `index.ts` composes and hands to `NexxusCli`. Same idea as
 * `ApiServices` in the reference runnables (the CLI omits Redis).
 */
export interface CliServices {
  configManager: NexxusConfigManager;
  logger: NexxusBaseLogger<any>;
  database: AnyNexxusDatabaseAdapter;
  message_queue: AnyMessageQueueAdapter;
}

/**
 * Args common to every command. Empty today — shared flags (e.g. a future global
 * `--verbose`) get added here, and because each command's `*Args` type composes
 * this, they flow into every command automatically.
 */
export interface CommandArgs {}

/**
 * {@link CliServices} plus the parsed args. `TArgs` (bounded by {@link CommandArgs})
 * lets a command declare the exact shape argparse produces for it, so `ctx.args` is
 * typed instead of a bare record. `database` is connected by the time a command runs.
 */
export interface CommandContext<TArgs extends CommandArgs = CommandArgs> extends CliServices {
  args: TArgs;
}

/**
 * The command resolved from `process.argv` plus the raw parsed args, produced by
 * `NexxusCli.parseArgs()` before any config or services are loaded.
 */
export interface ParsedInvocation {
  // `Command<any>` because the collection is heterogeneous — each command has its
  // own TArgs; the concrete command narrows `ctx.args` from the dynamic parse result.
  handler: Command<any>;
  args: Record<string, unknown>;
}

/**
 * Base class for a top-level CLI command. A command adds its own
 * flags / positionals / sub-actions in `configure()` and does its work in
 * `execute()`; `TArgs` names the parsed-args shape it expects (see each
 * command's *Args type). Register a new command by adding an instance to the
 * `commands` list in `NexxusCli`.
 */
export abstract class Command<TArgs extends CommandArgs = CommandArgs> {
  protected abstract readonly name: string;
  protected abstract readonly description: string;

  /** Attach this command's parser to the root subparsers action. */
  public register(commandParsers: SubParser): void {
    const parser = commandParsers.add_parser(this.name, {
      help: this.description,
      description: this.description,
    });

    parser.set_defaults({ handler: this });
    this.configure(parser);
  }

  /** Optional hook to add flags / positionals / sub-actions to this command's parser. */
  protected configure(_parser: ArgumentParser): void {
    // no-op by default
  }

  /** Run the command against the composed services and parsed args. */
  public abstract execute(ctx: CommandContext<TArgs>): Promise<void>;
}
