import {
  FatalErrorException,
  MODEL_REGISTRY,
  type NexxusApplication,
} from '@mayhem93/nexxus-core-lib';

import { Command, type CommandArgs, type CommandContext } from '../cli/Command.ts';
import { buildAclRole } from '../cli/aclRole.ts';

import type { ArgumentParser } from 'argparse';

/** Parsed args for `acl` (`action` is the chosen subcommand). */
interface AclArgs extends CommandArgs {
  action: 'create';
  appId: string;
  payload: string;
}

/**
 * `acl` — manage an application's ACL roles. Roles are per-app documents living
 * in the application's own `acl` index, separate from the Application document
 * that references them by name, so they're created against an application that
 * already exists (`app create` handles the roles an app is born with).
 *
 * Further actions (list/show/delete) become additional subparsers dispatched below.
 */
export class AclCommand extends Command<AclArgs> {
  protected readonly name = 'acl';
  protected readonly description = 'Manage application ACL roles.';

  protected configure(parser: ArgumentParser): void {
    const actions = parser.add_subparsers({ dest: 'action', required: true, metavar: '<action>' });

    const create = actions.add_parser('create', { help: 'Create an ACL role for an application from a JSON payload.' });

    create.add_argument('--app-id', {
      dest: 'appId',
      required: true,
      metavar: '<id>',
      help: 'Id of the application the role belongs to.',
    });

    create.add_argument('--payload', {
      required: true,
      metavar: '<json|path>',
      help: "Role definition: an inline JSON object ('{...}') or a path to a .json file (bare path or file:// URL).",
    });
  }

  public async execute(ctx: CommandContext<AclArgs>): Promise<void> {
    switch (ctx.args.action) {
      case 'create':
        await this.createRole(ctx);
        break;

      default:
        throw new FatalErrorException(`Unknown acl action: ${String(ctx.args.action)}`);
    }
  }

  private async createRole(ctx: CommandContext<AclArgs>): Promise<void> {
    const payload = this.resolveJsonObjectArgument(ctx.args.payload, '--payload');
    const app = await this.loadApplication(ctx, ctx.args.appId);
    const role = buildAclRole(payload, app, '--payload');

    await ctx.database.createItems([role]);

    // A role nothing references yet is fine — a user type is pointed at it by a
    // later application update. The reverse (a user type naming a role that
    // doesn't exist) is what turns fatal at node boot.
    ctx.logger.info(`ACL role created: ${role.getName()} (application ${ctx.args.appId})`, 'NxxCli');
  }

  /**
   * Loads the owning application — needed twice over: the role's statements are
   * validated against its schema, and only an ACL-enabled application has an
   * `acl` index (the bootstrapper creates it in `onApplicationCreated`, gated on
   * that flag), so writing a role to one without it would land in storage the
   * deployment never provisioned.
   */
  private async loadApplication(ctx: CommandContext<AclArgs>, appId: string): Promise<NexxusApplication> {
    // Note: the adapter drops missing documents rather than returning null for
    // them, so an unknown id yields an empty array, not `[null]`.
    const [app] = await ctx.database.getItems({ ids: [appId], type: MODEL_REGISTRY.application });

    if (!app) {
      throw new FatalErrorException(`Application "${appId}" not found.`);
    }

    if (!app.isAclEnabled()) {
      throw new FatalErrorException(
        `Application "${appId}" does not have ACLs enabled ("auth.acl": true), so it has no ACL role storage.`
      );
    }

    return app;
  }
}
