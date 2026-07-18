import {
  NexxusApplication,
  FatalErrorException,
  type INexxusApplication,
} from '@mayhem93/nexxus-core-lib';

import { Command, type CommandArgs, type CommandContext } from '../cli/Command.ts';

import type { ArgumentParser } from 'argparse';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Parsed args for `app` (`action` is the chosen subcommand). */
interface AppArgs extends CommandArgs {
  action: 'create';
  payload: string;
}

/**
 * `app` — manage Nexxus applications. `create` builds a NexxusApplication from a
 * JSON payload, provisions its per-app storage, then persists it. Further
 * actions (list/show/delete) become additional subparsers dispatched below.
 */
export class AppCommand extends Command<AppArgs> {
  protected readonly name = 'app';
  protected readonly description = 'Manage Nexxus applications.';

  protected configure(parser: ArgumentParser): void {
    const actions = parser.add_subparsers({ dest: 'action', required: true, metavar: '<action>' });

    const create = actions.add_parser('create', { help: 'Create an application from a JSON payload.' });

    create.add_argument('--payload', {
      required: true,
      metavar: '<json|path>',
      help: "Application definition: an inline JSON object ('{...}') or a path to a .json file (bare path or file:// URL).",
    });
  }

  public async execute(ctx: CommandContext<AppArgs>): Promise<void> {
    switch (ctx.args.action) {
      case 'create':
        await this.createApp(ctx);
        break;

      default:
        throw new FatalErrorException(`Unknown app action: ${String(ctx.args.action)}`);
    }
  }

  private async createApp(ctx: CommandContext<AppArgs>): Promise<void> {
    const payload = this.resolvePayload(ctx.args.payload);
    const app = new NexxusApplication(payload as INexxusApplication);

    // Provision per-app storage first (idempotent), then persist the Application
    // document. The doc is the commit point: the app only becomes visible once its
    // storage exists. createItems is not idempotent (re-create -> duplicate error).
    await ctx.database.getBootstrapper().onApplicationCreated(app);
    await ctx.database.createItems([app]);

    ctx.logger.info(`Application created: ${app.getData().id}`, 'NxxCli');
  }

  /**
   * Resolves `--payload` to a parsed JSON object. A value whose trimmed form
   * starts with `{` is treated as inline JSON; anything else is a file path
   * (bare, or a `file://` URL).
   */
  private resolvePayload(raw: string): unknown {
    const trimmed = raw.trim();
    const text = trimmed.startsWith('{') ? trimmed : readFileSync(this.toFilePath(raw), 'utf8');

    let parsed: unknown;

    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new FatalErrorException(`--payload is not valid JSON: ${(err as Error).message}`);
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new FatalErrorException('--payload must be a JSON object.');
    }

    return parsed;
  }

  private toFilePath(raw: string): string {
    return raw.startsWith('file://') ? fileURLToPath(raw) : raw;
  }
}
