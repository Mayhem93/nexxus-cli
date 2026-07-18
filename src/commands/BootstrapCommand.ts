import type { ArgumentParser, SubParser } from 'argparse';
import { FatalErrorException } from '@mayhem93/nexxus-core-lib';

import { Command, type CommandArgs, type CommandContext } from '../cli/Command.ts';

/**
 * Parsed args for `bootstrap`, discriminated on the chosen `target`. The runtime
 * message-queue credentials exist only for the `message-queue` target. Composed
 * with {@link CommandArgs} so shared args flow in.
 */
type BootstrapArgs = CommandArgs & (
  | { target: 'database' }
  | { target: 'message-queue'; runtimeUser: string; runtimePassword: string }
);

type BootstrapMessageQueueArgs = Extract<BootstrapArgs, { target: 'message-queue' }>;

/**
 * `bootstrap` — provisions Nexxus infrastructure. Each target (`database`,
 * `message-queue`, ...) is a subparser dispatched to its own private method;
 * no per-target classes.
 */
export class BootstrapCommand extends Command<BootstrapArgs> {
  protected readonly name = 'bootstrap';
  protected readonly description = 'Bootstrap Nexxus services (database, message-queue, ...).';

  // Hardcoded standard data-pipeline stages (core's NexxusBuiltInQueuePayloadMap +
  // NexxusDynamicQueuePayloadMap). The MQ bootstrapper declares one queue per STATIC
  // stage and skips the dynamic ones itself, so we hand it the full list.
  // TODO: source this from config once the pipeline supports pluggable workers beyond
  // the standard set.
  private static readonly PIPELINE: string[] = [
    'writer',
    'transport-manager',
    'websockets-transport',
    'mqtt-transport',
  ];

  protected configure(parser: ArgumentParser): void {
    const targets = parser.add_subparsers({ dest: 'target', required: true, metavar: '<target>' });

    this.configureDatabaseTarget(targets);
    this.configureMessageQueueTarget(targets);
  }

  private configureDatabaseTarget(targets: SubParser): void {
    targets.add_parser('database', { help: 'Bootstrap the configured database (idempotent).' });
  }

  private configureMessageQueueTarget(targets: SubParser): void {
    const messageQueue = targets.add_parser('message-queue', {
      help: 'Bootstrap the configured message queue (idempotent).',
    });

    messageQueue.add_argument('--runtime-user', {
      dest: 'runtimeUser',
      required: true,
      metavar: '<user>',
      help: 'Runtime message-queue user to create — the less-privileged user the workers connect as.',
    });

    messageQueue.add_argument('--runtime-password', {
      dest: 'runtimePassword',
      required: true,
      metavar: '<password>',
      help: 'Password for the runtime message-queue user.',
    });
  }

  public async execute(ctx: CommandContext<BootstrapArgs>): Promise<void> {
    const { args } = ctx;

    switch (args.target) {
      case 'database':
        await this.bootstrapDatabase(ctx);
        break;

      case 'message-queue':
        await this.bootstrapMessageQueue(ctx, args);
        break;

      default:
        throw new FatalErrorException(`Unknown bootstrap target: ${String(ctx.args.target)}`);
    }
  }

  private async bootstrapDatabase(ctx: CommandContext<BootstrapArgs>): Promise<void> {
    await ctx.database.getBootstrapper().bootstrapDeployment();
  }

  private async bootstrapMessageQueue(
    ctx: CommandContext<BootstrapArgs>,
    args: BootstrapMessageQueueArgs
  ): Promise<void> {
    // The MQ bootstrapper runs over the broker's HTTP management API — no adapter
    // connection needed (it's what creates the vhost the adapter later connects to).
    const bootstrapper = ctx.message_queue.getBootstrapper({
      runtimeUser: args.runtimeUser,
      runtimePassword: args.runtimePassword,
    });

    await bootstrapper.bootstrapDeployment(BootstrapCommand.PIPELINE);
  }
}
